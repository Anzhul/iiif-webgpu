# Performance Analysis: TileManager (iiif-tile.ts)

## Executive Summary
**Overall Assessment**: ⭐ **WELL-OPTIMIZED**

The TileManager is significantly better optimized than the Camera was. However, there are still a few **minor issues** and some opportunities for optimization in hot paths.

---

## Critical Issues Found

### Issue #1: Redundant `hasViewportChanged()` Calls in `getLoadedTilesForRender()` 🟡

**Location**: `iiif-tile.ts:377` and `iiif-tile.ts:405`

**Problem**:
```typescript
getLoadedTilesForRender(viewport: any) {
    // FIRST call - checks if viewport changed
    const viewportChanged = this.hasViewportChanged(viewport);  // Line 377

    if (viewportChanged || !this.cachedNeededTileIds) {
        // ... recalculate tiles ...

        // SECOND call - updates viewport cache
        this.updateViewportCache(viewport);  // Line 405
    }
}
```

`hasViewportChanged()` performs **5 Math.abs() operations + 5 comparisons** to check if viewport changed. This is called **every frame** (60 times per second).

**Issue**: When viewport hasn't changed (most common case when idle), we're still doing 5 Math.abs calls + 5 comparisons for no reason.

**Impact**:
- **~300 operations per second** when idle (5 ops × 60 FPS)
- Not critical, but wasteful for the idle case

**Severity**: 🟡 LOW-MEDIUM (idle overhead)

---

### Issue #2: Expensive Array Operations in `getLoadedTilesForRender()` ⚠️

**Location**: `iiif-tile.ts:423-428`

**Problem**:
```typescript
let tileSetHash = `${neededTileIds.size}`;
if (neededTileIds.size > 0) {
    // EXPENSIVE: Convert Set to Array every frame
    const idsArray = Array.from(neededTileIds);  // Line 426
    tileSetHash += `_${idsArray[0]}_${idsArray[idsArray.length - 1]}`;
}
```

**Issue**: `Array.from(neededTileIds)` is called **every frame** to create a hash, even when cached sorted tiles are valid.

**Cost Breakdown**:
- `Array.from()`: Allocates new array and iterates entire Set
- For 20 tiles: ~20 iterations + 1 allocation
- For 50 tiles: ~50 iterations + 1 allocation
- Called 60 times per second = **1200-3000 iterations/sec + 60 allocations/sec**

**Impact**: Medium - happens every frame during pan/zoom

**Severity**: ⚠️ MEDIUM

---

### Issue #3: Multiple Array Allocations in Tile ID Generation ⚠️

**Location**: `iiif-tile.ts:386-401`

**Problem**:
```typescript
neededTileIds = new Set<string>();  // Allocates new Set
for (let tileY = startTileY; tileY <= endTileY; tileY++) {
    for (let tileX = startTileX; tileX <= endTileX; tileX++) {
        // ... bounds check ...
        const tileId = `${zoomLevel}-${tileX}-${tileY}`;  // String allocation
        neededTileIds.add(tileId);
    }
}
```

**Issue**: When viewport changes, this creates:
- 1 new Set per frame
- ~20-50 new string IDs per frame (template literals allocate)

**Impact**:
- **20-50 string allocations + 1 Set allocation** per viewport change
- During smooth pan/zoom: ~1200-3000 allocations per second

**Severity**: ⚠️ MEDIUM (during pan/zoom)

---

### Issue #4: Sort Operations Without Early Exit ⚠️

**Location**: `iiif-tile.ts:447, 471, 478`

**Problem**:
```typescript
// Three different places where tiles are sorted
const sortedTiles = loadedTiles.sort((a, b) => a.z - b.z);  // Line 447
const sortedTiles = Array.from(tileMap.values()).sort((a, b) => a.z - b.z);  // Line 471
const sortedTiles = loadedTiles.sort((a, b) => a.z - b.z);  // Line 478
```

**Issue**:
- Sorting is O(n log n) - for 20 tiles, ~86 comparisons
- No early exit when tiles are already sorted (common case)
- Cache helps but still runs on first frame after viewport change

**Impact**:
- ~86-200 comparisons per sort (depending on tile count)
- Happens on every viewport change

**Severity**: 🟡 LOW-MEDIUM

---

### Issue #5: Redundant Filter Operation in Cache Validation

**Location**: `iiif-tile.ts:433-440`

**Problem**:
```typescript
if (this.cachedTileSetHash === tileSetHash && this.cachedSortedTiles) {
    // Filter cached sorted tiles to only include currently loaded ones
    const stillValid = this.cachedSortedTiles.filter(tile =>
        neededTileIds.has(tile.id) && this.tileCache.has(tile.id)  // Double lookup!
    );

    if (stillValid.length === neededTileIds.size) {
        return stillValid;
    }
}
```

**Issue**:
- `filter()` creates new array (allocation)
- Does **two Map/Set lookups per tile** (`neededTileIds.has` + `tileCache.has`)
- For 20 tiles: 40 lookups + 1 allocation
- Called every frame when cache hash matches

**Impact**:
- **40-100 lookups per frame** + 1 allocation
- **2400-6000 lookups/sec** at 60 FPS when cache is valid

**Severity**: ⚠️ MEDIUM

---

## Good Optimizations Already Present ✅

### 1. ✅ Viewport Change Threshold
```typescript
private hasViewportChanged(viewport: any): boolean {
    const threshold = 0.001; // ~0.1% movement threshold
    // Only recalculate when movement exceeds threshold
}
```
**Good**: Prevents recalculating on tiny movements. Well implemented.

---

### 2. ✅ Cached Tile Boundaries
```typescript
private cachedNeededTileIds: Set<string> | null = null;
private cachedViewportState: { ... } | null = null;
```
**Good**: Caches tile IDs between frames. Avoids expensive recalculation.

---

### 3. ✅ Cached Sorted Tiles
```typescript
private cachedSortedTiles: any[] | null = null;
private cachedTileSetHash: string | null = null;
```
**Good**: Caches sorted result. Avoids re-sorting same tiles.

---

### 4. ✅ LRU Cache Management
```typescript
private markTileAccessed(tileId: string) {
    this.tileAccessOrder.delete(tileId);
    this.tileAccessOrder.add(tileId);
}
```
**Good**: Efficient LRU tracking using Set insertion order.

---

### 5. ✅ Priority-Based Tile Loading
```typescript
tilesToLoad.sort((a, b) => {
    const aPriority = a.priority !== undefined ? a.priority : Infinity;
    const bPriority = b.priority !== undefined ? b.priority : Infinity;
    return aPriority - bPriority;
});
```
**Good**: Loads tiles closest to viewport center first.

---

### 6. ✅ GPU Upload Queue
```typescript
private queueGPUUpload(tileId: string, bitmap: ImageBitmap) {
    this.pendingGPUUploads.push({ tileId, bitmap });
    if (!this.isProcessingUploads) {
        this.processGPUUploadQueue();
    }
}
```
**Good**: Non-blocking GPU uploads spread across frames.

---

## Performance Metrics

### Current Costs Per Frame (60 FPS)

| Operation | When | Cost Per Frame | Cost Per Second |
|-----------|------|----------------|-----------------|
| `hasViewportChanged()` | Every frame | 5 Math.abs + 5 comparisons | ~600 ops |
| `Array.from(neededTileIds)` | When generating hash | 20-50 iterations + 1 alloc | 1200-3000 iters + 60 allocs |
| Tile ID generation | Viewport change | 20-50 string allocs | 1200-3000 allocs (during pan) |
| `filter()` for cache validation | Cache hash match | 40-100 lookups + 1 alloc | 2400-6000 lookups |
| Tile sorting | Cache miss | 86-200 comparisons | Variable |

### Breakdown by Scenario

| Scenario | Operations/Frame | Operations/Second (60 FPS) |
|----------|------------------|----------------------------|
| **Idle, cache valid** | ~10 (hasViewportChanged + hash check) | ~600 |
| **Idle, cache invalid** | ~100 (recalc + sort) | ~6000 |
| **Pan/zoom** | ~200-300 | ~12000-18000 |

---

## Optimization Recommendations

### 🔴 HIGH PRIORITY

#### 1. Optimize Hash Generation (Avoid `Array.from()`)

**Current**:
```typescript
const idsArray = Array.from(neededTileIds);
tileSetHash += `_${idsArray[0]}_${idsArray[idsArray.length - 1]}`;
```

**Optimized**:
```typescript
// Use Set iterator (no allocation)
if (neededTileIds.size > 0) {
    const first = neededTileIds.values().next().value;  // First item
    // For last item, keep a reference during Set construction
    // OR use a simpler hash that doesn't need last item
    tileSetHash += `_${first}`;
}
```

**Better Alternative**: Use zoom level + tile count as hash:
```typescript
let tileSetHash = `${zoomLevel}-${neededTileIds.size}`;
```

**Savings**:
- Eliminates 1200-3000 iterations/sec + 60 allocations/sec
- **~95% reduction** in hash generation cost

---

#### 2. Optimize Cache Validation (Remove `filter()`)

**Current**:
```typescript
const stillValid = this.cachedSortedTiles.filter(tile =>
    neededTileIds.has(tile.id) && this.tileCache.has(tile.id)
);

if (stillValid.length === neededTileIds.size) {
    return stillValid;
}
```

**Optimized**:
```typescript
// Fast path: Just check if cached tiles are still valid
// No need to filter and allocate new array
if (this.cachedSortedTiles.length === neededTileIds.size) {
    // Quick validation: all cached tiles still needed and loaded
    let allValid = true;
    for (const tile of this.cachedSortedTiles) {
        if (!neededTileIds.has(tile.id) || !this.tileCache.has(tile.id)) {
            allValid = false;
            break;  // Early exit
        }
    }

    if (allValid) {
        return this.cachedSortedTiles;  // Return cached array directly
    }
}
```

**Savings**:
- Eliminates 1 allocation per frame
- Adds early exit when first tile is invalid
- **~50% reduction** in cache validation cost

---

### 🟡 MEDIUM PRIORITY

#### 3. Reuse Set for Tile IDs (Avoid Allocations)

**Current**:
```typescript
neededTileIds = new Set<string>();  // New Set every viewport change
```

**Optimized**:
```typescript
// Add to class
private reusableTileIdSet: Set<string> = new Set();

// In getLoadedTilesForRender()
if (viewportChanged || !this.cachedNeededTileIds) {
    const neededTileIds = this.reusableTileIdSet;
    neededTileIds.clear();  // Reuse instead of allocate

    for (let tileY = startTileY; tileY <= endTileY; tileY++) {
        for (let tileX = startTileX; tileX <= endTileX; tileX++) {
            // ... bounds check ...
            const tileId = `${zoomLevel}-${tileX}-${tileY}`;
            neededTileIds.add(tileId);
        }
    }

    this.cachedNeededTileIds = neededTileIds;
}
```

**Savings**:
- Eliminates 1 Set allocation per viewport change
- During smooth pan: **~60 allocations/sec eliminated**

---

#### 4. Pre-allocate Tile ID Strings (String Interning)

**Current**:
```typescript
const tileId = `${zoomLevel}-${tileX}-${tileY}`;  // Allocates string
```

**Optimized** (if tile coordinates are bounded):
```typescript
// Add to class - pre-computed tile IDs
private tileIdCache: Map<string, string> = new Map();

private getTileId(zoomLevel: number, tileX: number, tileY: number): string {
    const key = `${zoomLevel}-${tileX}-${tileY}`;
    let id = this.tileIdCache.get(key);
    if (!id) {
        id = key;
        this.tileIdCache.set(key, id);
    }
    return id;
}
```

**Tradeoff**: Uses more memory but eliminates string allocations for frequently accessed tiles.

**Savings**:
- **20-50 string allocations per viewport change eliminated** (after warm-up)
- During pan: **~1200-3000 allocations/sec eliminated**

---

### 🟢 LOW PRIORITY

#### 5. Add Early Exit for Sorted Tiles

**Current**:
```typescript
const sortedTiles = loadedTiles.sort((a, b) => a.z - b.z);
```

**Optimized**:
```typescript
// Check if already sorted (common case after first frame at zoom level)
function isSorted(tiles: any[]): boolean {
    for (let i = 1; i < tiles.length; i++) {
        if (tiles[i].z < tiles[i - 1].z) {
            return false;
        }
    }
    return true;
}

// Only sort if needed
if (!isSorted(loadedTiles)) {
    loadedTiles.sort((a, b) => a.z - b.z);
}
```

**Savings**:
- Avoids ~86-200 comparisons when tiles are already sorted
- **~50% reduction** in sort cost for stable zoom levels

---

#### 6. Skip `hasViewportChanged()` When Idle Flag Set

**Idea**: Camera already tracks idle state. Pass idle flag to TileManager.

**Current**:
```typescript
requestTilesForViewport(viewport: any) {
    if (!this.hasViewportChanged(viewport)) {
        return;
    }
    // ...
}
```

**Optimized**:
```typescript
requestTilesForViewport(viewport: any, isIdle: boolean = false) {
    if (isIdle) {
        return;  // Skip all checks if idle
    }

    if (!this.hasViewportChanged(viewport)) {
        return;
    }
    // ...
}
```

**Savings**: Eliminates 5 Math.abs calls when camera is idle

---

## Code Quality Issues

### 1. Type Safety - `any` Everywhere
```typescript
tileCache: Map<string, any>;
createTile(...): any { ... }
getLoadedTilesForRender(viewport: any) { ... }
```

**Issue**: No type safety. Easy to introduce bugs.

**Recommendation**: Define proper TypeScript interfaces:
```typescript
interface Tile {
    id: string;
    url?: string;
    x: number;
    y: number;
    z: number;
    width: number;
    height: number;
    tileX: number;
    tileY: number;
    zoomLevel: number;
    scaleFactor: number;
    image?: ImageBitmap;
    priority?: number;
}

interface ViewportState {
    centerX: number;
    centerY: number;
    scale: number;
    containerWidth: number;
    containerHeight: number;
}

tileCache: Map<string, Tile>;
```

---

### 2. Magic Numbers
```typescript
const threshold = 0.001; // ~0.1% movement threshold (line 78)
const margin = includeMargin ? tileSize * scaleFactor : 0; (line 127)
const toRemoveCount = Math.floor(this.maxCacheSize * 0.2); (line 537)
```

**Recommendation**: Extract to named constants:
```typescript
private readonly CONFIG = {
    VIEWPORT_CHANGE_THRESHOLD: 0.001,
    PRELOAD_MARGIN_MULTIPLIER: 1,
    CACHE_EVICTION_RATIO: 0.2
} as const;
```

---

## Estimated Performance Gains from Optimizations

| Optimization | Scenario | Savings/Frame | Savings/Second (60 FPS) |
|--------------|----------|---------------|-------------------------|
| Optimize hash generation | Pan/zoom | ~30-50 ops | ~1800-3000 ops |
| Optimize cache validation | Cache hit | ~20-50 ops + 1 alloc | ~1200-3000 ops + 60 allocs |
| Reuse tile ID Set | Viewport change | 1 alloc | ~60 allocs (during pan) |
| String interning | Viewport change | 20-50 allocs | ~1200-3000 allocs (during pan) |
| Skip hasViewportChanged when idle | Idle | 5-10 ops | ~300-600 ops |
| **TOTAL** | **Combined** | **~75-160 ops** | **~4500-9600 ops + 1320-3120 allocs** |

### Expected Improvements:
- **Idle performance**: 30-50% reduction (currently very good already)
- **Pan/zoom performance**: 40-60% reduction in overhead
- **Memory pressure**: ~1320-3120 fewer allocations/sec during pan/zoom

---

## Comparison: TileManager vs Camera

| Metric | Camera (Before) | TileManager (Current) |
|--------|-----------------|----------------------|
| **Code Quality** | Good structure | Good structure |
| **Idle Overhead** | High (~1200 ops/sec) | Low (~600 ops/sec) |
| **Cache Strategy** | Basic | Excellent (multi-level) |
| **Allocations** | High (180/sec) | Medium (60-3000/sec) |
| **Optimization Level** | Poor (fixed) | Good (can be better) |

**Verdict**: TileManager is already **much better optimized** than Camera was. The issues found are minor compared to Camera's problems.

---

## Recommendations Priority

### Implement Now (High ROI, Low Effort):
1. ✅ Optimize hash generation (avoid `Array.from()`) - **5 minutes, big impact**
2. ✅ Optimize cache validation (remove `filter()`) - **10 minutes, big impact**

### Implement Soon (Medium ROI, Medium Effort):
3. Reuse Set for tile IDs - **10 minutes, medium impact**
4. Skip hasViewportChanged when idle - **5 minutes, small impact**

### Implement Later (Lower Priority):
5. String interning for tile IDs - **30 minutes, memory tradeoff**
6. Add early exit for sorted tiles - **15 minutes, small impact**
7. Add proper TypeScript types - **60 minutes, code quality**

---

## Testing Recommendations

### Performance Profiling
```javascript
// Add to TileManager
private perfStats = {
    hashGenTime: 0,
    cacheValidationTime: 0,
    sortTime: 0,
    callCount: 0
};

getLoadedTilesForRender(viewport: any) {
    const t0 = performance.now();
    // ... hash generation ...
    this.perfStats.hashGenTime += performance.now() - t0;

    // ... etc

    if (++this.perfStats.callCount % 600 === 0) {
        console.log('TileManager stats (10 sec avg):', {
            avgHashTime: this.perfStats.hashGenTime / 600,
            avgValidationTime: this.perfStats.cacheValidationTime / 600,
            avgSortTime: this.perfStats.sortTime / 600
        });
        // Reset
        this.perfStats = { hashGenTime: 0, cacheValidationTime: 0, sortTime: 0, callCount: 0 };
    }
}
```

---

## Conclusion

**Overall Assessment**: ⭐ **WELL-OPTIMIZED CODE**

The TileManager shows **good optimization awareness**:
- ✅ Multi-level caching (viewport state, tile IDs, sorted tiles)
- ✅ Intelligent cache invalidation
- ✅ Priority-based loading
- ✅ Non-blocking GPU uploads
- ✅ LRU cache management

**Minor Issues Found**:
- Some redundant operations in hot paths
- Unnecessary allocations during pan/zoom
- No idle optimization (but Camera now has this)

**Recommended Action**:
- Implement 2 quick fixes (hash + cache validation) for **40-60% improvement** in hot paths
- Consider other optimizations based on profiling results
- Much less urgent than Camera optimizations were

The code is in good shape overall! 🎉
