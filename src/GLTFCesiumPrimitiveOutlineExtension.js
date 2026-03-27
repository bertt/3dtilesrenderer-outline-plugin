import * as THREE from 'three';

const EXTENSION_NAME = 'CESIUM_primitive_outline';

/**
 * GLTFCesiumPrimitiveOutlineExtension
 *
 * A Three.js GLTFLoader plugin that renders building outlines encoded with the
 * CESIUM_primitive_outline extension:
 * https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/CESIUM_primitive_outline/README.md
 *
 * The extension stores pairs of vertex indices that mark which triangle edges
 * should be drawn as outlines. This plugin reads those indices, creates a
 * THREE.LineSegments mesh, and adds it as a child of the original mesh.
 *
 * A small perspective-correct depth bias is applied in the vertex shader so
 * that the lines do not depth-fight with the solid triangle geometry.
 *
 * Usage with 3d-tiles-renderer (manual loader setup):
 *
 *   import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
 *   import { GLTFCesiumPrimitiveOutlineExtension } from './GLTFCesiumPrimitiveOutlineExtension.js';
 *
 *   const outlineOpts = { showOutline: true, outlineColor: 0x000000 };
 *   const loader = new GLTFLoader( tiles.manager );
 *   loader.register( parser => new GLTFCesiumPrimitiveOutlineExtension( parser, outlineOpts ) );
 *   tiles.manager.addHandler( /(gltf|glb)$/g, loader );
 *
 * Options:
 *
 *   showOutline     {boolean}               Show or hide outlines. Default: true.
 *   outlineColor    {THREE.Color|number|string}
 *                                           Outline color used when no custom material
 *                                           is provided. Default: 0x000000 (black).
 *   outlineMaterial {THREE.Material}        Supply a fully custom Three.js material.
 *                                           When set, outlineColor is ignored.
 *                                           Pass the same instance for all tiles to
 *                                           minimise draw-call state changes.
 *
 * Runtime visibility toggle:
 *   After tiles are loaded, traverse tiles.group to show / hide outlines:
 *
 *   tiles.group.traverse( obj => {
 *     if ( obj.isLineSegments && obj.name.endsWith( '_outline' ) ) {
 *       obj.visible = false;
 *     }
 *   } );
 */
export class GLTFCesiumPrimitiveOutlineExtension {

	/**
	 * @param {import('three/examples/jsm/loaders/GLTFLoader.js').GLTFParser} parser
	 *   GLTFParser instance — supplied by the GLTFLoader registration factory.
	 * @param {object} [options]
	 * @param {boolean} [options.showOutline=true]
	 * @param {THREE.Color|number|string} [options.outlineColor=0x000000]
	 * @param {THREE.Material} [options.outlineMaterial]
	 */
	constructor( parser, options = {} ) {

		this.parser = parser;
		this.name = EXTENSION_NAME;
		this.showOutline = options.showOutline !== false;

		if ( options.outlineMaterial ) {

			this._material = options.outlineMaterial;

		} else {

			const color = new THREE.Color( options.outlineColor ?? 0x000000 );

			// Shader material with a perspective-correct depth bias.
			// clipPos.w equals the view-space depth, so subtracting a fraction of it
			// pushes the lines uniformly toward the camera regardless of viewing distance.
			this._material = new THREE.ShaderMaterial( {
				uniforms: {
					diffuse: { value: color },
				},
				vertexShader: /* glsl */`
					void main() {
						vec4 clip = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
						// Perspective-correct depth bias — prevents z-fighting with solid faces.
						clip.z -= 0.0002 * clip.w;
						gl_Position = clip;
					}
				`,
				fragmentShader: /* glsl */`
					uniform vec3 diffuse;
					void main() {
						gl_FragColor = vec4( diffuse, 1.0 );
					}
				`,
				depthTest: true,
				depthWrite: false,
			} );

		}

	}

	/**
	 * Called by Three.js GLTFLoader after the full glTF scene has been parsed.
	 * Finds every mesh primitive with the CESIUM_primitive_outline extension,
	 * loads its edge-index accessor, and attaches a LineSegments child.
	 *
	 * @param {{ scene: THREE.Group }} gltf
	 * @returns {Promise<void>}
	 */
	async afterRoot( gltf ) {

		if ( ! this.showOutline ) return;

		const parser = this.parser;
		const json = parser.json;

		if ( ! json.meshes ) return;

		const pending = [];

		gltf.scene.traverse( object => {

			if ( ! object.isMesh ) return;

			// parser.associations maps parsed Three.js objects back to their
			// position in the raw glTF JSON (available since Three.js r154).
			const assoc = parser.associations?.get( object );
			if ( ! assoc ) return;

			// Association keys use the plural form of the glTF array name.
			const meshIndex = assoc.meshes ?? assoc.mesh;
			const primIndex = assoc.primitives ?? assoc.primitive;
			if ( meshIndex == null || primIndex == null ) return;

			const primDef = json.meshes[ meshIndex ]?.primitives?.[ primIndex ];
			const ext = primDef?.extensions?.[ EXTENSION_NAME ];
			if ( ! ext ) return;

			const task = parser.loadAccessor( ext.indices )
				.then( indicesAttr => {

					const lineGeom = new THREE.BufferGeometry();

					// Share the position buffer from the parent geometry.
					// LineSegments live and die with their parent mesh, so the
					// shared buffer is always valid while these lines are rendered.
					lineGeom.setAttribute( 'position', object.geometry.attributes.position );
					lineGeom.setIndex( indicesAttr );

					const lines = new THREE.LineSegments( lineGeom, this._material );
					lines.name = `${ object.name || 'mesh' }_outline`;

					// Render after the parent so the depth buffer is already populated.
					lines.renderOrder = object.renderOrder + 1;

					// Identity transform relative to parent — no local update needed.
					lines.matrixAutoUpdate = false;

					object.add( lines );

				} )
				.catch( err => {

					console.warn(
						`[${ EXTENSION_NAME }] Could not load accessor ${ ext.indices }:`,
						err
					);

				} );

			pending.push( task );

		} );

		await Promise.all( pending );

	}

}
