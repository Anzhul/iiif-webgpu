struct TileUniforms {
    // Combined transformation matrix: MVP × Model
    // Pre-multiplied on CPU to avoid redundant GPU matrix operations
    combinedMatrix: mat4x4<f32>,    // Transforms tile quad directly to clip space
}

@group(0) @binding(0) var<storage, read> tileData: array<TileUniforms>;
@group(0) @binding(1) var textureSampler: sampler;
@group(0) @binding(2) var tileTexture: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
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

    // Transform unit quad vertex directly to clip space using pre-combined matrix
    // Matrix was pre-multiplied on CPU: combinedMatrix = MVP × Model
    let clipPos = uniforms.combinedMatrix * vec4<f32>(pos, 1.0);

    var output: VertexOutput;
    output.position = clipPos;
    output.texCoord = vec2<f32>(pos.x, pos.y);
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // Add small epsilon to avoid sampling exactly at texture edges (0.0 or 1.0)
    // This prevents flickering artifacts at tile boundaries due to floating-point precision
    let epsilon = 0.0001;
    let clampedCoord = clamp(input.texCoord, vec2<f32>(epsilon), vec2<f32>(1.0 - epsilon));

    // Sample the texture with slightly inset coordinates
    return textureSample(tileTexture, textureSampler, clampedCoord);
}