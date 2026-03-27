# 3dtilesrenderer-outline-plugin

A Three.js GLTFLoader plugin that renders building outlines encoded with the
[CESIUM_primitive_outline](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/CESIUM_primitive_outline/README.md)
extension, designed for use with
[3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS).

The plugin reads the edge-index accessor embedded in each glTF primitive and
draws a `THREE.LineSegments` child mesh for every outlined face.  A small
perspective-correct depth bias in the vertex shader prevents z-fighting against
the solid triangle geometry.

## Requirements

- Three.js r154 or later (requires `GLTFParser.associations`)
- 3DTilesRendererJS 0.4 or later (optional but the primary target)
- 3D Tiles content produced with `--add_outlines true` in
  [pg2b3dm](https://github.com/Geodan/pg2b3dm)

## Installation

```
npm install 3dtilesrenderer-outline-plugin
```

Or copy `src/GLTFCesiumPrimitiveOutlineExtension.js` directly into your project.

## Usage

The plugin is a standard Three.js GLTFLoader plugin.  Register it with the
factory pattern that Three.js requires so each parsed file gets its own parser
instance while options are shared via closure.

### With 3DTilesRendererJS (manual loader setup)

Replace the built-in `GLTFExtensionsPlugin` with a manually-configured
`GLTFLoader` so you can register additional GLTF plugins alongside the standard
ones:

```js
import { TilesRenderer } from '3d-tiles-renderer';
import { ImplicitTilingPlugin } from '3d-tiles-renderer/core/plugins';
import {
  GLTFMeshFeaturesExtension,
  GLTFStructuralMetadataExtension,
  GLTFCesiumRTCExtension,
} from '3d-tiles-renderer/three/plugins';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { GLTFCesiumPrimitiveOutlineExtension } from '3dtilesrenderer-outline-plugin';

const tiles = new TilesRenderer( url );
tiles.registerPlugin( new ImplicitTilingPlugin() );

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath( '/path/to/draco/' );

const ktx2Loader = new KTX2Loader();
ktx2Loader.setTranscoderPath( '/path/to/basis/' );
ktx2Loader.detectSupport( renderer );

// Options shared across all tile files loaded in this session.
const outlineOptions = {
  showOutline: true,
  outlineColor: 0x000000,
};

const loader = new GLTFLoader( tiles.manager );
loader.setDRACOLoader( dracoLoader );
loader.setKTX2Loader( ktx2Loader );
loader.register( () => new GLTFMeshFeaturesExtension() );
loader.register( () => new GLTFStructuralMetadataExtension() );
loader.register( () => new GLTFCesiumRTCExtension() );
loader.register( parser => new GLTFCesiumPrimitiveOutlineExtension( parser, outlineOptions ) );

tiles.manager.addHandler( /(gltf|glb)$/g, loader );
```

### With a plain GLTFLoader

```js
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFCesiumPrimitiveOutlineExtension } from '3dtilesrenderer-outline-plugin';

const loader = new GLTFLoader();
loader.register( parser => new GLTFCesiumPrimitiveOutlineExtension( parser, {
  showOutline: true,
  outlineColor: 0x1a1a2e,
} ) );

loader.load( 'model.glb', gltf => {
  scene.add( gltf.scene );
} );
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `showOutline` | `boolean` | `true` | Render outlines. Set to `false` to disable on construction. |
| `outlineColor` | `THREE.Color \| number \| string` | `0x000000` | Outline color. Accepts any value that `new THREE.Color()` accepts. Ignored when `outlineMaterial` is set. |
| `outlineMaterial` | `THREE.Material` | — | Fully custom Three.js material. Overrides `outlineColor`. Pass the same material instance across all tiles to keep draw-call state uniform. |

## Toggling visibility at runtime

The plugin adds children named `<mesh-name>_outline` to each outlined mesh.
After the tiles are loaded, traverse the tile group to show or hide all outlines:

```js
function setOutlinesVisible( tilesGroup, visible ) {
  tilesGroup.traverse( obj => {
    if ( obj.isLineSegments && obj.name.endsWith( '_outline' ) ) {
      obj.visible = visible;
    }
  } );
}

// Hide outlines
setOutlinesVisible( tiles.group, false );

// Show outlines again
setOutlinesVisible( tiles.group, true );
```

## Custom material

To control line width, opacity, or any other property, supply a custom material:

```js
import * as THREE from 'three';

const mat = new THREE.ShaderMaterial( {
  uniforms: {
    diffuse: { value: new THREE.Color( 0x003366 ) },
    opacity: { value: 0.6 },
  },
  vertexShader: `
    void main() {
      vec4 clip = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      clip.z -= 0.0002 * clip.w;
      gl_Position = clip;
    }
  `,
  fragmentShader: `
    uniform vec3 diffuse;
    uniform float opacity;
    void main() {
      gl_FragColor = vec4( diffuse, opacity );
    }
  `,
  transparent: true,
  depthTest: true,
  depthWrite: false,
} );

loader.register( parser => new GLTFCesiumPrimitiveOutlineExtension( parser, {
  outlineMaterial: mat,
} ) );
```

## Generating outlined 3D Tiles with pg2b3dm

Use the `--add_outlines true` flag:

```bash
pg2b3dm \
  -h localhost \
  -d postgres \
  -U postgres \
  -p 5432 \
  -c geom \
  -t public.sibbe \
  -a identificatie \
  --keep_projection false \
  --add_outlines true
```

This embeds `CESIUM_primitive_outline` in every glTF primitive of the generated
3D Tiles content.

## How it works

1. `afterRoot` is called by Three.js once a glTF file has been fully parsed.
2. The plugin traverses the resulting scene and checks `parser.associations` to
   map each `THREE.Mesh` back to its raw glTF JSON primitive definition.
3. For every primitive that has a `CESIUM_primitive_outline` extension block, the
   plugin calls `parser.loadAccessor` to load the edge-index buffer (pairs of
   vertex indices marking which edges to draw).
4. A `THREE.BufferGeometry` is created that shares the parent mesh position
   attribute and uses the edge indices.
5. A `THREE.LineSegments` mesh with a shader material is added as a child of the
   original mesh.  The shader applies a perspective-correct depth bias
   (`clip.z -= 0.0002 * clip.w`) that prevents the lines from z-fighting with
   the solid faces.

## Publishing to npm

1. Set your package name in `package.json` — the default name
   `3dtilesrenderer-outline-plugin` is available but you may want to scope it
   (e.g. `@yourorg/3dtilesrenderer-outline-plugin`).
2. Log in: `npm login`
3. Publish: `npm publish --access public`

The package uses `"type": "module"` and native ES module exports.  Bundlers
(Vite, webpack, Rollup) and Node.js 18+ import it directly without transpilation.

To publish a scoped package:
```json
{
  "name": "@yourorg/3dtilesrenderer-outline-plugin"
}
```

```bash
npm publish --access public
```

## Compatibility with other plugins

The plugin follows the same registration pattern as the GLTF extension plugins
shipped with 3DTilesRendererJS (`GLTFMeshFeaturesExtension`,
`GLTFStructuralMetadataExtension`).  All plugins coexist on the same
`GLTFLoader` instance without conflict.

## Sample

See [`sample/sibbe/`](sample/sibbe/) for a complete MapLibre GL JS viewer that
combines OpenFreeMap vector tiles, Mapterhorn terrain, and 3D Tiles of the BAG
building dataset for Sibbe (Limburg, Netherlands) with black outlines.

## License

MIT
