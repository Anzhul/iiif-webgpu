struct Uniforms {
    // Viewport transform
    viewportCenter: vec2<f32>,      // Normalized center (0-1)
    viewportScale: f32,             // Zoom scale
    _padding0: f32,                 // Explicit padding to match TypeScript layout
    canvasSize: vec2<f32>,          // Canvas dimensions
    _padding1: vec2<f32>,           // Explicit padding

    // Image info
    imageSize: vec2<f32>,           // Full image dimensions
    _padding2: vec2<f32>,           // Explicit padding

    // Tile info
    tilePosition: vec2<f32>,        // Tile position in image space
    _padding3: vec2<f32>,           // Explicit padding
    tileSize: vec2<f32>,            // Tile dimensions in image space
    _padding4: vec2<f32>,           // Explicit padding
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var textureSampler: sampler;
@group(0) @binding(2) var tileTexture: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    // Create a unit quad (0,0) to (1,1)
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0)
    );

    let pos = positions[vertexIndex];

    // Calculate viewport center in image pixel coordinates
    let viewportCenterPixels = uniforms.viewportCenter * uniforms.imageSize;

    // Calculate viewport size in image pixels (accounting for zoom)
    let viewportSize = uniforms.canvasSize / uniforms.viewportScale;

    // Calculate viewport min position in image space
    let viewportMin = viewportCenterPixels - viewportSize * 0.5;

    // Calculate tile position in image space
    let tileMin = uniforms.tilePosition;
    let tileMax = uniforms.tilePosition + uniforms.tileSize;

    // Interpolate between tile min and max based on vertex position
    let tilePos = mix(tileMin, tileMax, pos);

    // Transform tile position to viewport space
    let viewportPos = (tilePos - viewportMin) * uniforms.viewportScale;

    // Convert to normalized device coordinates (clip space)
    let normalized = viewportPos / uniforms.canvasSize;
    let clip = normalized * 2.0 - 1.0;
    // Flip Y: image space has Y=0 at top, clip space has Y=-1 at top
    let clipPos = vec2<f32>(clip.x, -clip.y);

    var output: VertexOutput;
    output.position = vec4<f32>(clipPos, 0.0, 1.0);
    output.texCoord = pos;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // Sample the texture
    return textureSample(tileTexture, textureSampler, input.texCoord);
}