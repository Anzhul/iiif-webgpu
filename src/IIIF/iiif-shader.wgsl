struct TileUniforms {
    // 3D Model-View-Projection matrix (combined transformation)
    mvpMatrix: mat4x4<f32>,         // Complete 3D transformation from world to clip space

    // Model matrix for the tile (transforms tile space to world space)
    modelMatrix: mat4x4<f32>,       // Position and scale of this specific tile

    // Tile info
    tilePosition: vec2<f32>,        // Tile position in image space (for reference)
    _padding0: vec2<f32>,           // Explicit padding
    tileSize: vec2<f32>,            // Tile dimensions in image space (for reference)
    _padding1: vec2<f32>,           // Explicit padding
}

@group(0) @binding(0) var<storage, read> tileData: array<TileUniforms>;
@group(0) @binding(1) var textureSampler: sampler;
@group(0) @binding(2) var tileTexture: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
    @location(1) worldPos: vec3<f32>,  // World space position for potential effects
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) tileIndex: u32) -> VertexOutput {
    // Create a unit quad (0,0) to (1,1) in 3D space
    var positions = array<vec3<f32>, 6>(
        vec3<f32>(0.0, 0.0, 0.0),
        vec3<f32>(1.0, 0.0, 0.0),
        vec3<f32>(0.0, 1.0, 0.0),
        vec3<f32>(0.0, 1.0, 0.0),
        vec3<f32>(1.0, 0.0, 0.0),
        vec3<f32>(1.0, 1.0, 0.0)
    );

    let pos = positions[vertexIndex];

    // Get uniforms for this tile instance
    let uniforms = tileData[tileIndex];

    // Transform unit quad vertex to world space using the tile's model matrix
    let worldPos4 = uniforms.modelMatrix * vec4<f32>(pos, 1.0);

    // Apply the combined Model-View-Projection matrix to transform to clip space
    // This handles camera position, orientation, and projection in one step
    let clipPos = uniforms.mvpMatrix * worldPos4;

    var output: VertexOutput;
    output.position = clipPos;
    output.texCoord = vec2<f32>(pos.x, pos.y);
    output.worldPos = worldPos4.xyz;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // Sample the texture
    return textureSample(tileTexture, textureSampler, input.texCoord);
}