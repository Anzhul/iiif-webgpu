struct Uniforms {
    // Transformation matrices
    viewMatrix: mat4x4<f32>,        // Handles pan and zoom
    projectionMatrix: mat4x4<f32>,  // Maps image space to clip space

    // Tile info
    tilePosition: vec2<f32>,        // Tile position in image space
    _padding0: vec2<f32>,           // Explicit padding
    tileSize: vec2<f32>,            // Tile dimensions in image space
    _padding1: vec2<f32>,           // Explicit padding
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

    // Map vertex (0-1) to tile position in image space
    let tileTL = uniforms.tilePosition;
    let tileBR = uniforms.tilePosition + uniforms.tileSize;
    let tilePos = mix(tileTL, tileBR, pos);

    // Create 4D position vector in image space
    let worldPos = vec4<f32>(tilePos, 0.0, 1.0);

    // Apply view and projection matrices to transform to clip space
    let clipPos = uniforms.projectionMatrix * uniforms.viewMatrix * worldPos;

    var output: VertexOutput;
    output.position = clipPos;
    output.texCoord = pos;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // Sample the texture
    return textureSample(tileTexture, textureSampler, input.texCoord);
}