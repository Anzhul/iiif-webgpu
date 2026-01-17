# Animation Loop & Tile Throttling Analysis

## Complete Animation Loop Flow

### Overview Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    MAIN RENDER LOOP (60 FPS)                    │
│                    iiif.ts:286 - loop()                         │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. updateAnimations()                                          │
│     ├─ Check: camera.isAnimating()                             │
│     │   ├─ YES → Skip interactive (programmatic anim running)  │
│     │   └─ NO  → camera.updateInteractiveAnimation()           │
│     │                                                            │
│     └─ Interactive Animation Updates Viewport:                 │
│         ├─ Pan: viewport.centerX/Y                             │
│         └─ Zoom: viewport.cameraZ & scale                      │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. tileManager.getLoadedTilesForRender(viewport)              │
│     ├─ Checks viewport cache                                   │
│     ├─ Returns loaded tiles (NO network requests)              │
│     └─ Uses fallback tiles if new tiles not loaded             │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. renderer.render(viewport, image, tiles, thumbnail)         │
│     └─ WebGPU renders frame                                    │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
                    requestAnimationFrame(loop)
                                 │
                                 └──► (back to top)
```

---

## Detailed Flow Breakdown

### Phase 1: Render Loop Entry Point
**Location**: `iiif.ts:286-294`

```typescript
const loop = () => {
    if (!this.renderLoopActive) return;
    this.render(imageId);                          // ← Main render call
    this.animationFrameId = requestAnimationFrame(loop);
};
```

**Frequency**: Called ~60 times per second (browser dependent)

**Purpose**: Main animation loop that drives everything

---

### Phase 2: Update Animations
**Location**: `iiif.ts:134-139` → `iiif-camera.ts:624-674`

```typescript
// iiif.ts
private updateAnimations() {
    if (!this.camera.isAnimating()) {              // ← Check programmatic animations
        this.camera.updateInteractiveAnimation();   // ← Update interactive (pan/zoom)
    }
}
```

**Critical Decision Point**:
- **Programmatic animation running** (`.to()`, `.zoom()`, `.pan()` called)?
  - YES → Skip interactive animation (avoid conflicts)
  - NO → Update interactive animation (trailing pan/zoom)

#### 2a. Interactive Animation Update (When Active)

**Location**: `iiif-camera.ts:624-674`

```typescript
updateInteractiveAnimation() {
    // OPTIMIZATION: Early exit if idle
    if (this.isIdle) {
        return this.updateResult;  // ← Returns cached { needsUpdate: false }
    }

    // Calculate deltas (pan distance, zoom delta)
    const deltas = this.calculateInteractiveDeltas();

    // Check if animation should continue
    const hasPanAnimation = state.isDragging ||
        deltas.panDistanceSquared > PAN_ANIMATION_THRESHOLD_SQ;
    const hasZoomAnimation = deltas.zoomAbs > ZOOM_ANIMATION_THRESHOLD;

    // Go idle if no animation needed
    if (!hasPanAnimation && !hasZoomAnimation) {
        this.isIdle = true;
        return { needsUpdate: false };
    }

    // Apply trailing effect (exponential decay)
    if (hasPanAnimation) {
        currentCanvasX += panDeltaX * 0.08;  // ← 8% of remaining distance
        currentCanvasY += panDeltaY * 0.08;
    }

    if (hasZoomAnimation) {
        currentCameraZ += zoomDelta * 0.08;  // ← 8% of remaining distance

        // OPTIMIZATION: Only update scale if Z changed significantly
        if (Math.abs(currentCameraZ - lastScaleUpdateZ) > 1.0) {
            viewport.updateScale();  // ← Expensive operation
        }
    }

    // Transform viewport (anchor point system)
    applyInteractiveTransform();  // ← Sets viewport.centerX/Y

    // Request tiles if movement is significant
    if (isSignificant) {
        requestTilesThrottled(imageId, now);  // ← THIS IS WHERE TILES ARE REQUESTED
    }

    return { needsUpdate: true, imageId };
}
```

**Key Behaviors**:
1. **Idle Optimization**: Skips all work when no animation active (~100% CPU saving)
2. **Trailing Effect**: Moves 8% of remaining distance each frame
3. **Smooth Convergence**: Exponentially approaches target position
4. **Tile Request**: Only requests tiles if movement is significant

---

## Tile Request Flow & Throttling

### Request Path

```
User Interaction (drag/zoom)
         │
         ▼
Camera.startInteractivePan() / handleWheel()
         │
         ├─ Sets: targetCanvasX/Y, targetCameraZ
         └─ Wakes camera: isIdle = false
         │
         ▼
Every Frame (60 FPS):
    updateInteractiveAnimation()
         │
         ├─ Calculates: current position (trailing)
         ├─ Updates: viewport.centerX/Y, viewport.cameraZ
         │
         ├─ Check: Is movement significant?
         │    ├─ panDistance > 1.0 pixels? OR
         │    └─ zoomDelta > 0.1 units?
         │
         └─ IF SIGNIFICANT:
              requestTilesThrottled(imageId, now)  ← Lines 666
                     │
                     ▼
         ┌──────────────────────────────────┐
         │  TILE THROTTLING CHECK           │
         │  (Lines 398-411)                 │
         └──────────────────────────────────┘
                     │
                     ▼
         timeSinceLastRequest <= 25ms?
              │
              ├─ YES → BLOCKED (throttled)
              │         Return early
              │         console.log('Tile request throttled')
              │
              └─ NO  → ALLOWED
                      tileManager.requestTilesForViewport(viewport)
                      lastTileRequestTime = now
```

---

## Tile Throttling Deep Dive

### Current Implementation

**Location**: `iiif-camera.ts:398-411`

```typescript
private requestTilesThrottled(imageId: string, now: number): void {
    const timeSinceLastRequest = now - this.lastTileRequestTime;

    // THROTTLE: Block if less than 25ms since last request
    if (timeSinceLastRequest <= this.CONFIG.TILE_REQUEST_THROTTLE) {
        console.log('Tile request throttled');  // ← DEBUG LOG
        return;  // ← BLOCKED
    }

    console.log("Requesting tiles");  // ← DEBUG LOG

    const tileManager = this.tiles.get(imageId);
    if (tileManager) {
        tileManager.requestTilesForViewport(this.viewport);  // ← ALLOWED
        this.lastTileRequestTime = now;
    }
}
```

### Configuration

```typescript
TILE_REQUEST_THROTTLE: 25,  // milliseconds (40 requests/sec max)
```

### Throttling Analysis

#### Current Behavior at 60 FPS

**Frame Budget**: 16.67ms per frame (1000ms / 60 FPS)

**Throttle Window**: 25ms (1.5 frames)

**Maximum Request Rate**: 40 requests/second

| Frame # | Time (ms) | Request Allowed? | Reason |
|---------|-----------|------------------|--------|
| 0 | 0 | ✅ YES | Initial request |
| 1 | 16.67 | ❌ NO | 16.67ms < 25ms (throttled) |
| 2 | 33.33 | ✅ YES | 33.33ms > 25ms (allowed) |
| 3 | 50.00 | ❌ NO | 16.67ms < 25ms (throttled) |
| 4 | 66.67 | ✅ YES | 33.33ms > 25ms (allowed) |

**Result**: Tiles are requested **every ~2 frames** during continuous animation.

#### Why This Matters

**Without Throttling** (60 requests/sec):
- TileManager recalculates viewport bounds 60 times/sec
- Checks cache 60 times/sec
- Potentially sends 60 HTTP requests/sec (if tiles not cached)
- **Overwhelms network and browser**

**With 25ms Throttling** (40 requests/sec):
- Reduces tile calculations by 33%
- Network requests reduced by 33%
- Still responsive (every 2 frames is imperceptible)
- **Good balance between performance and smoothness**

---

## ⚠️ ISSUE FOUND: Tile Throttling Conflict

### Problem: Double Throttling System

**Issue**: There are TWO separate throttling mechanisms:

1. **Camera Throttling** (iiif-camera.ts:398-411)
   - Throttle window: 25ms
   - Controls frequency of **calls to TileManager**

2. **TileManager Throttling** (iiif-tile.ts:296-300)
   - Uses viewport change detection (0.1% threshold)
   - Controls frequency of **tile recalculation**

```typescript
// Camera side (Line 398)
private requestTilesThrottled(imageId: string, now: number): void {
    if (timeSinceLastRequest <= 25) return;  // ← First throttle
    tileManager.requestTilesForViewport(viewport);
}

// TileManager side (Line 296)
requestTilesForViewport(viewport: any) {
    if (!this.hasViewportChanged(viewport)) return;  // ← Second throttle
    // ... calculate and request tiles
}
```

### Analysis

**Current Flow**:
```
Frame 1: Camera throttle PASS → TileManager throttle PASS → Tiles requested
Frame 2: Camera throttle BLOCK → (never reaches TileManager)
Frame 3: Camera throttle PASS → TileManager throttle CHECK → Maybe tiles requested
```

**Is This a Problem?**

🟡 **PARTIALLY REDUNDANT BUT SAFE**

**Good Aspects**:
- Defense in depth (two layers of protection)
- Camera throttle reduces TileManager calls (saves function call overhead)
- TileManager throttle catches edge cases (e.g., programmatic camera calls)

**Redundant Aspects**:
- If Camera throttle is tuned correctly, TileManager throttle rarely triggers
- Two different throttle mechanisms can be confusing

**Performance Impact**: **LOW** - The Camera throttle prevents most unnecessary TileManager calls

---

## Tile Request Timing Analysis

### Scenario: Smooth Pan Animation

**User Action**: Drag mouse continuously for 1 second

| Time (ms) | Frame # | Camera Throttle | TileManager Call | Tiles Requested |
|-----------|---------|-----------------|------------------|-----------------|
| 0 | 0 | ✅ PASS | ✅ Called | ✅ YES (viewport changed) |
| 17 | 1 | ❌ BLOCK | - | - |
| 33 | 2 | ✅ PASS | ✅ Called | ✅ YES (viewport changed) |
| 50 | 3 | ❌ BLOCK | - | - |
| 67 | 4 | ✅ PASS | ✅ Called | ✅ YES (viewport changed) |
| 83 | 5 | ❌ BLOCK | - | - |
| 100 | 6 | ✅ PASS | ✅ Called | ✅ YES (viewport changed) |

**Result**: ~30 tile requests during 1 second of smooth panning

### Scenario: Idle (No User Interaction)

| Time (ms) | Frame # | Camera Idle Check | Throttle Check | Tiles Requested |
|-----------|---------|-------------------|----------------|-----------------|
| 0 | 0 | ✅ IDLE | - | NO |
| 17 | 1 | ✅ IDLE | - | NO |
| 33 | 2 | ✅ IDLE | - | NO |
| ... | ... | ✅ IDLE | - | NO |

**Result**: **ZERO** tile requests when idle (optimization working perfectly!)

---

## Critical Paths Summary

### Hot Path 1: Interactive Animation (Every Frame When Active)
```
updateInteractiveAnimation()
  ├─ calculateInteractiveDeltas()      [~10 ops]
  ├─ updatePanAnimation()               [~3 ops]
  ├─ updateZoomAnimation()              [~5 ops, sometimes +9 for updateScale]
  ├─ applyInteractiveTransform()        [~8 ops]
  └─ requestTilesThrottled()            [~3 ops, sometimes calls TileManager]
      └─ TileManager.requestTilesForViewport()  [~50-200 ops when called]
```

**Total Cost Per Frame**:
- **When idle**: ~0 ops (early exit)
- **When animating, tiles NOT requested**: ~30 ops
- **When animating, tiles requested**: ~80-230 ops

### Hot Path 2: Tile Rendering (Every Frame)
```
tileManager.getLoadedTilesForRender(viewport)
  ├─ hasViewportChanged()               [~10 ops - always called]
  ├─ Use cached tile IDs (most frames)  [~5 ops]
  │   OR
  ├─ Recalculate tile IDs (viewport changed)  [~50-100 ops]
  └─ Return sorted tiles                [0 ops if cached, ~200 ops if resort needed]
```

**Total Cost Per Frame**:
- **Viewport unchanged**: ~15 ops
- **Viewport changed**: ~65-300 ops

---

## Throttling Effectiveness

### Current Configuration Assessment

| Parameter | Value | Assessment |
|-----------|-------|------------|
| **TILE_REQUEST_THROTTLE** | 25ms | ✅ GOOD - Every ~2 frames at 60 FPS |
| **PAN_SIGNIFICANT_THRESHOLD** | 1.0 pixels | ✅ GOOD - Prevents tile spam on tiny moves |
| **ZOOM_SIGNIFICANT_THRESHOLD** | 0.1 units | ✅ GOOD - Prevents tile spam on tiny zooms |
| **TileManager viewport threshold** | 0.001 (0.1%) | ✅ GOOD - Catches sub-pixel changes |

### Recommendation: Throttle Settings

**Current settings are well-tuned!** No changes needed.

**Alternative Configurations** (if you want to experiment):

#### More Aggressive (Lower Tile Requests)
```typescript
TILE_REQUEST_THROTTLE: 50,        // 20 requests/sec (every 3 frames)
PAN_SIGNIFICANT_THRESHOLD: 2.0,   // Only request if moved 2+ pixels
ZOOM_SIGNIFICANT_THRESHOLD: 0.5,  // Only request if zoomed 0.5+ units
```
**Tradeoff**: Fewer requests, but tiles might not load as smoothly during fast panning

#### More Responsive (Higher Tile Requests)
```typescript
TILE_REQUEST_THROTTLE: 16,        // 60 requests/sec (every frame)
PAN_SIGNIFICANT_THRESHOLD: 0.5,   // Request on any 0.5+ pixel move
ZOOM_SIGNIFICANT_THRESHOLD: 0.05, // Request on any 0.05+ unit zoom
```
**Tradeoff**: More network activity, higher CPU usage, but tiles load faster

---

## Console Logs in Production

### ⚠️ Issue: Debug Logs Left in Code

**Location**: `iiif-camera.ts:401, 404`

```typescript
if (timeSinceLastRequest <= this.CONFIG.TILE_REQUEST_THROTTLE) {
    console.log('Tile request throttled');  // ← REMOVE FOR PRODUCTION
    return;
}
console.log("Requesting tiles");  // ← REMOVE FOR PRODUCTION
```

**Impact**:
- Every 2 frames: "Requesting tiles" logged
- Every other frame: "Tile request throttled" logged
- **30-60 console logs per second during animation**
- Console logging has overhead (~0.1ms per log)
- Can slow down DevTools

**Recommendation**: Remove or wrap in debug flag

```typescript
// Option 1: Remove completely
if (timeSinceLastRequest <= this.CONFIG.TILE_REQUEST_THROTTLE) {
    return;
}

// Option 2: Debug flag (better for development)
private readonly DEBUG = false;

if (timeSinceLastRequest <= this.CONFIG.TILE_REQUEST_THROTTLE) {
    if (this.DEBUG) console.log('Tile request throttled');
    return;
}
if (this.DEBUG) console.log("Requesting tiles");
```

---

## Animation Timing Characteristics

### Trailing Effect Behavior

**Trailing Factor**: 0.08 (8% per frame)

**Convergence Time**: Time to reach 95% of target

```
Frame 1: 8% of remaining distance
Frame 2: 8% of remaining 92% = cumulative 15.36%
Frame 3: 8% of remaining 84.64% = cumulative 22.13%
...
Frame 35: ~95% of distance covered
```

**Time to reach 95%**: ~35 frames = **~583ms at 60 FPS**

**Visual Result**: Smooth, buttery trailing animation

### Comparison: Different Trailing Factors

| Factor | Frames to 95% | Time at 60 FPS | Feel |
|--------|---------------|----------------|------|
| 0.05 | ~60 frames | ~1000ms | Very floaty, slow |
| 0.08 | ~35 frames | ~583ms | Smooth, responsive (current) |
| 0.12 | ~24 frames | ~400ms | Snappy, quick |
| 0.20 | ~14 frames | ~233ms | Very direct, less trailing |

**Current value (0.08) is well-balanced** for smooth, responsive feel.

---

## Summary & Recommendations

### ✅ What's Working Well

1. **Idle Optimization**: Camera goes to sleep when no animation needed
2. **Tile Throttling**: 25ms window prevents request spam
3. **Significance Thresholds**: Only requests tiles on meaningful movement
4. **TileManager Caching**: Viewport change detection works well
5. **Trailing Animation**: 0.08 factor feels smooth and responsive

### 🟡 Minor Issues

1. **Debug Console Logs**: Remove production logs (Lines 401, 404)
2. **Double Throttling**: Camera + TileManager throttles are redundant but safe

### 🟢 Recommended Actions

#### Priority 1: Remove Debug Logs
```typescript
// Remove or wrap in debug flag
private requestTilesThrottled(imageId: string, now: number): void {
    const timeSinceLastRequest = now - this.lastTileRequestTime;
    if (timeSinceLastRequest <= this.CONFIG.TILE_REQUEST_THROTTLE) {
        return;  // Remove console.log
    }

    const tileManager = this.tiles.get(imageId);
    if (tileManager) {
        tileManager.requestTilesForViewport(this.viewport);
        this.lastTileRequestTime = now;
    }
}
```

#### Priority 2: (Optional) Consolidate Throttling
Consider removing TileManager's viewport change throttle since Camera already throttles:

```typescript
// iiif-camera.ts - Keep this
private requestTilesThrottled(imageId: string, now: number): void { ... }

// iiif-tile.ts - Simplify this
requestTilesForViewport(viewport: any) {
    // Remove hasViewportChanged check (Camera already throttles)
    // OR keep it as defensive programming (current approach)
}
```

**Recommendation**: Keep both for defense in depth. Current approach is safe.

---

## Performance Metrics

### Overhead Per Frame (60 FPS)

| State | Camera Cost | TileManager Cost | Total |
|-------|-------------|------------------|-------|
| **Idle** | 0 ops | 15 ops | **15 ops** |
| **Animating (no tiles)** | 30 ops | 15 ops | **45 ops** |
| **Animating (with tiles)** | 30 ops | 65-300 ops | **95-330 ops** |

### Tile Request Frequency

| Scenario | Requests/Second | Network Activity |
|----------|-----------------|------------------|
| **Idle** | 0 | None |
| **Slow pan** | 10-20 | Low |
| **Fast pan** | 30-40 | Medium (capped by throttle) |
| **Zoom** | 30-40 | Medium (capped by throttle) |

**Conclusion**: Throttling is working effectively to cap maximum request rate at 40/sec.
