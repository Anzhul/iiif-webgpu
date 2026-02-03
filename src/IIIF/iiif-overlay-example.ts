/**
 * Example usage of the IIIFOverlayManager
 *
 * This file demonstrates how to add HTML overlays to your IIIF images
 * that automatically follow pan and zoom transformations.
 * All coordinates are in world space (which equals image pixel dimensions for single images).
 */

import { IIIFViewer } from './iiif';
import type { OverlayElement } from './iiif-overlay';

/**
 * Example 1: Add a simple colored box overlay
 */
export function addSimpleBoxOverlay(viewer: IIIFViewer) {
    if (!viewer.overlayManager) {
        console.error('Overlay manager not initialized');
        return;
    }

    // Create an HTML element
    const box = document.createElement('div');
    box.style.backgroundColor = 'rgba(255, 0, 0, 0.3)';
    box.style.border = '2px solid red';
    box.style.boxSizing = 'border-box';

    // Define the overlay in world coordinates
    const overlay: OverlayElement = {
        id: 'red-box',
        element: box,
        worldX: 1000,      // X position in world units
        worldY: 500,        // Y position in world units
        worldWidth: 500,    // Width in world units
        worldHeight: 300,   // Height in world units
        scaleWithZoom: true  // Box will scale with zoom level
    };

    viewer.overlayManager.addOverlay(overlay);
}

/**
 * Example 2: Add a label overlay with text
 */
export function addLabelOverlay(
    viewer: IIIFViewer,
    text: string,
    x: number,
    y: number
) {
    if (!viewer.overlayManager) {
        console.error('Overlay manager not initialized');
        return;
    }

    const label = document.createElement('div');
    label.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
    label.style.color = 'white';
    label.style.padding = '8px';
    label.style.borderRadius = '4px';
    label.style.fontSize = '14px';
    label.style.fontFamily = 'Arial, sans-serif';
    label.style.whiteSpace = 'nowrap';
    label.textContent = text;

    const overlay: OverlayElement = {
        id: `label-${Date.now()}`,
        element: label,
        worldX: x,
        worldY: y,
        worldWidth: 150,
        worldHeight: 40,
        scaleWithZoom: true
    };

    viewer.overlayManager.addOverlay(overlay);
}

/**
 * Example 3: Add an interactive button overlay
 */
export function addButtonOverlay(
    viewer: IIIFViewer,
    x: number,
    y: number,
    onClick: () => void
) {
    if (!viewer.overlayManager) {
        console.error('Overlay manager not initialized');
        return;
    }

    const button = document.createElement('button');
    button.textContent = 'Click Me';
    button.style.padding = '10px 20px';
    button.style.cursor = 'pointer';
    button.style.border = 'none';
    button.style.borderRadius = '4px';
    button.style.backgroundColor = '#4CAF50';
    button.style.color = 'white';
    button.style.fontSize = '14px';
    button.style.fontFamily = 'Arial, sans-serif';

    button.addEventListener('click', onClick);

    const overlay: OverlayElement = {
        id: `button-${Date.now()}`,
        element: button,
        worldX: x,
        worldY: y,
        worldWidth: 100,
        worldHeight: 40,
        scaleWithZoom: true
    };

    viewer.overlayManager.addOverlay(overlay);
}

/**
 * Example 4: Add multiple overlays at once (like highlighting regions)
 */
export function addHighlightRegions(
    viewer: IIIFViewer,
    regions: Array<{ x: number; y: number; width: number; height: number; color?: string }>
) {
    if (!viewer.overlayManager) {
        console.error('Overlay manager not initialized');
        return;
    }

    regions.forEach((region, index) => {
        const highlight = document.createElement('div');
        highlight.style.backgroundColor = region.color || 'rgba(255, 255, 0, 0.3)';
        highlight.style.border = '2px solid yellow';
        highlight.style.boxSizing = 'border-box';

        const overlay: OverlayElement = {
            id: `highlight-${index}`,
            element: highlight,
            worldX: region.x,
            worldY: region.y,
            worldWidth: region.width,
            worldHeight: region.height,
            scaleWithZoom: true
        };

        viewer.overlayManager?.addOverlay(overlay);
    });
}

/**
 * Example 5: Add a draggable overlay (advanced)
 */
export function addDraggableOverlay(
    viewer: IIIFViewer,
    initialX: number,
    initialY: number
) {
    if (!viewer.overlayManager) {
        console.error('Overlay manager not initialized');
        return;
    }

    const draggable = document.createElement('div');
    draggable.style.backgroundColor = 'rgba(0, 123, 255, 0.5)';
    draggable.style.border = '2px solid blue';
    draggable.style.borderRadius = '50%';
    draggable.style.cursor = 'move';
    draggable.style.boxSizing = 'border-box';

    const overlayId = `draggable-${Date.now()}`;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;

    draggable.addEventListener('mousedown', (e) => {
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        e.stopPropagation(); // Prevent viewer pan
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging || !viewer.overlayManager) return;

        const overlay = viewer.overlayManager.getOverlay(overlayId);
        if (!overlay) return;

        // Calculate delta in screen pixels
        const deltaX = e.clientX - dragStartX;
        const deltaY = e.clientY - dragStartY;

        // Convert to world units
        const scale = viewer.viewport.scale;
        const deltaWorldX = deltaX / scale;
        const deltaWorldY = deltaY / scale;

        // Update overlay position
        viewer.overlayManager.updateOverlayPosition(
            overlayId,
            overlay.worldX + deltaWorldX,
            overlay.worldY + deltaWorldY
        );

        dragStartX = e.clientX;
        dragStartY = e.clientY;
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });

    const overlay: OverlayElement = {
        id: overlayId,
        element: draggable,
        worldX: initialX,
        worldY: initialY,
        worldWidth: 100,
        worldHeight: 100,
        scaleWithZoom: true
    };

    viewer.overlayManager.addOverlay(overlay);
}

/**
 * Example 6: Add an overlay that doesn't scale with zoom
 */
export function addFixedSizeOverlay(
    viewer: IIIFViewer,
    x: number,
    y: number
) {
    if (!viewer.overlayManager) {
        console.error('Overlay manager not initialized');
        return;
    }

    const marker = document.createElement('div');
    marker.style.width = '20px';
    marker.style.height = '20px';
    marker.style.backgroundColor = 'red';
    marker.style.borderRadius = '50%';
    marker.style.border = '2px solid white';

    const overlay: OverlayElement = {
        id: `marker-${Date.now()}`,
        element: marker,
        worldX: x,
        worldY: y,
        worldWidth: 20,
        worldHeight: 20,
        scaleWithZoom: false  // Overlay stays same size regardless of zoom
    };

    viewer.overlayManager.addOverlay(overlay);
}

/**
 * Example usage in your main application
 */
export function exampleUsage() {
    // Assume you have a viewer instance
    const container = document.getElementById('iiif-container')!;
    const viewer = new IIIFViewer(container, {
        enableOverlays: true  // Make sure overlays are enabled
    });

    // Load an image
    viewer.addImage('my-image', 'https://example.com/iiif/image/info.json', true);
    viewer.startRenderLoop();
    viewer.listen();

    // Add overlays after image is loaded
    setTimeout(() => {
        // Add a simple box
        addSimpleBoxOverlay(viewer);

        // Add a label
        addLabelOverlay(viewer, 'Important Region', 2000, 1500);

        // Add a button
        addButtonOverlay(viewer, 3000, 2000, () => {
            console.log('Button clicked!');
        });

        // Add multiple highlights
        addHighlightRegions(viewer, [
            { x: 500, y: 500, width: 300, height: 200 },
            { x: 1000, y: 800, width: 400, height: 300, color: 'rgba(0, 255, 0, 0.3)' }
        ]);

        // Add a draggable overlay
        addDraggableOverlay(viewer, 1500, 1000);

        // Add a fixed-size marker
        addFixedSizeOverlay(viewer, 2500, 1800);
    }, 1000);

    // You can also remove overlays
    // viewer.overlayManager?.removeOverlay('red-box');

    // Or clear all overlays
    // viewer.overlayManager?.clearAllOverlays();
}
