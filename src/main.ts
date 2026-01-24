import './style.scss'
import { IIIFViewer } from './IIIF/iiif';

const container = document.getElementById('iiif-container');
if (container) {
    const viewer = new IIIFViewer(container, {
        toolbar: {
            zoom: true,
            annotations: true,
            CVButton: true,
            fullscreen: true
        },
        enableOverlays: true
    });

    // Expose viewer globally for debugging/testing
    (window as any).viewer = viewer;

    // Test multi-image manifest loading
    // Using a well-known public IIIF Presentation manifest with multiple canvases
    const testManifestUrl = 'https://iiif.bodleian.ox.ac.uk/iiif/manifest/e32a277e-91e2-4a6d-8ba6-cc4bad230410.json';

    console.log('Loading IIIF Presentation manifest:', testManifestUrl);

    viewer.loadManifest(testManifestUrl, {
        layout: 'grid',  // Try: 'horizontal', 'vertical', 'grid', 'book'
        gap: 1000
    })
    .then((manifestInfo) => {
        console.log('Manifest loaded successfully!');
        console.log('Manifest info:', manifestInfo);
        console.log(`Loaded ${viewer.images.size} images`);

        // Log each image's position
        for (const [id, image] of viewer.images) {
            console.log(`  ${id}: "${image.label}" at (${image.worldX}, ${image.worldY}) - ${image.width}x${image.height}`);
        }

        // Start the render loop
        viewer.startRenderLoop();

        console.log('\n--- Controls ---');
        console.log('viewer.setLayout("grid")     - Switch to grid layout');
        console.log('viewer.setLayout("vertical") - Switch to vertical layout');
        console.log('viewer.setLayout("book")     - Switch to book layout');
        console.log('viewer.fitToAllImages()      - Fit all images in view');
    })
    .catch((error) => {
        console.error('Error loading manifest:', error);

        // Fallback: try a simpler manifest or single image
        console.log('Trying fallback with single image...');
        viewer.addImage('fallback', 'https://free.iiifhosting.com/iiif/616bc3c8dc9a69d3e935139c8c77b76f32137cab7ce0e4fd2166507cdc948b/info.json', true)
            .then(() => {
                console.log('Fallback image loaded');
                viewer.listen('fallback');
                viewer.startRenderLoop('fallback');
            });
    });
} else {
    console.error('Container element not found');
}

/* ============================================
   ORIGINAL IMPLEMENTATION (commented out)
   ============================================

import {
    IIIFViewer,
    createLabel,
    createMarker,
    createHighlight,
    createInfoCard,
    createTooltip,
    createNumberedMarker,
    createCallout,
    createBadge
} from './IIIF/iiif';

const container = document.getElementById('iiif-container');
if (container) {
    const viewer = new IIIFViewer(container, {
        toolbar: {
            zoom: true,
            annotations: true,
            //layers: true,
            CVButton: true,
            fullscreen: true
        },
        enableOverlays: true  // Enable overlay system
    });

    // Expose viewer globally for debugging/testing
    (window as any).viewer = viewer;

    //viewer.addControls();
    viewer.listen('test');
    viewer.addImage('test','https://free.iiifhosting.com/iiif/616bc3c8dc9a69d3e935139c8c77b76f32137cab7ce0e4fd2166507cdc948b/info.json', true)
        .then(() => {
            console.log('Image loaded successfully');
            console.log('Viewer exposed on window.viewer - try: viewer.zoomByFactor(2, "test", 1000)');
            viewer.startRenderLoop('test');

            // Demo: Add some example overlays and annotations after a short delay
            setTimeout(() => {
                addDemoOverlays(viewer);
                addDemoAnnotations(viewer);
            }, 500);
        })
        .catch((error) => {
            console.error('Error loading or rendering:', error);
        });
} else {
    console.error('Container element not found');
}

// Demo function to show overlay system in action
function addDemoOverlays(viewer: IIIFViewer) {
    const image = viewer.images.get('test');
    if (!image) return;

    console.log('Adding demo overlays...');
    console.log(`Image dimensions: ${image.width}x${image.height}`);

    // Highlight box using factory
    viewer.addOverlay({
        id: 'demo-highlight',
        element: createHighlight({ borderColor: '#ff4444', backgroundColor: 'rgba(255, 68, 68, 0.1)' }),
        imageX: image.width * 0.3,
        imageY: image.height * 0.3,
        imageWidth: image.width * 0.4,
        imageHeight: image.height * 0.4,
        imageId: 'test',
        scaleWithZoom: true
    });

    // Label using factory
    viewer.addOverlay({
        id: 'demo-label',
        element: createLabel('Demo Overlay - Pan and Zoom!', { fontSize: '16px' }),
        imageX: image.width * 0.1,
        imageY: image.height * 0.1,
        imageWidth: 250,
        imageHeight: 40,
        imageId: 'test',
        scaleWithZoom: false  // Fixed size label
    });

    // Numbered markers using factory
    viewer.addOverlay({
        id: 'demo-marker-1',
        element: createNumberedMarker({ number: 1, label: 'Point A', color: '#e74c3c' }),
        imageX: image.width * 0.2,
        imageY: image.height * 0.25,
        imageWidth: 120,
        imageHeight: 32,
        imageId: 'test',
        scaleWithZoom: false
    });

    viewer.addOverlay({
        id: 'demo-marker-2',
        element: createNumberedMarker({ number: 2, label: 'Point B', color: '#3498db' }),
        imageX: image.width * 0.7,
        imageY: image.height * 0.2,
        imageWidth: 120,
        imageHeight: 32,
        imageId: 'test',
        scaleWithZoom: false
    });

    // Info card using factory
    viewer.addOverlay({
        id: 'demo-info-card',
        element: createInfoCard({
            title: 'Region of Interest',
            description: 'This area shows important details in the image.',
            headerBackground: '#9b59b6'
        }),
        imageX: image.width * 0.6,
        imageY: image.height * 0.7,
        imageWidth: 220,
        imageHeight: 100,
        imageId: 'test',
        scaleWithZoom: false
    });

    // Tooltip using factory
    viewer.addOverlay({
        id: 'demo-tooltip',
        element: createTooltip({
            title: 'Metadata',
            items: [
                { label: 'Width', value: `${image.width}px` },
                { label: 'Height', value: `${image.height}px` }
            ]
        }),
        imageX: image.width * 0.05,
        imageY: image.height * 0.7,
        imageWidth: 180,
        imageHeight: 90,
        imageId: 'test',
        scaleWithZoom: false
    });

    // Callout using factory
    viewer.addOverlay({
        id: 'demo-callout',
        element: createCallout({ text: 'Look here!', arrowPosition: 'bottom' }),
        imageX: image.width * 0.45,
        imageY: image.height * 0.15,
        imageWidth: 100,
        imageHeight: 50,
        imageId: 'test',
        scaleWithZoom: false
    });

    // Badge using factory
    viewer.addOverlay({
        id: 'demo-badge',
        element: createBadge('NEW', { background: '#27ae60', size: 'medium' }),
        imageX: image.width * 0.85,
        imageY: image.height * 0.1,
        imageWidth: 50,
        imageHeight: 24,
        imageId: 'test',
        scaleWithZoom: false
    });

    // Simple marker using factory
    viewer.addOverlay({
        id: 'demo-simple-marker',
        element: createMarker({ color: '#f39c12', size: 28, label: '!' }),
        imageX: image.width * 0.5,
        imageY: image.height * 0.4,
        imageWidth: 34,
        imageHeight: 34,
        imageId: 'test',
        scaleWithZoom: false
    });

    console.log('✓ Demo overlays added! Try panning and zooming to see them move.');
}

// Demo function to show annotation system in action
function addDemoAnnotations(viewer: IIIFViewer) {
    const image = viewer.images.get('test');
    if (!image) return;

    console.log('Adding demo annotations...');

    // Add a simple annotation with text
    viewer.addAnnotation({
        id: 'annotation-1',
        imageId: 'test',
        fixed: true,
        x: image.width * 0.5,
        y: image.height * 0.5,
        width: image.width * 0.2,
        height: image.height * 0.15,
        style: {
            border: '3px solid #ff6b6b',
            backgroundColor: 'rgba(255, 107, 107, 0.2)',
            borderRadius: '8px'
        },
        content: {
            text: 'Annotation with Text'
        },
        scaleWithZoom: true
    });

    // Add another annotation
    viewer.addAnnotation({
        id: 'annotation-2',
        imageId: 'test',
        fixed: true,
        x: image.width * 0.15,
        y: image.height * 0.6,
        width: image.width * 0.18,
        height: image.height * 0.12,
        style: {
            border: '2px solid #4ecdc4',
            backgroundColor: 'rgba(78, 205, 196, 0.15)',
            borderRadius: '4px'
        },
        content: {
            text: 'Another Annotation'
        },
        scaleWithZoom: true
    });

    // Add annotation with custom HTML element
    const customElement = document.createElement('div');
    customElement.innerHTML = `
        <div style="text-align: center; color: white;">
            <h4 style="margin: 0 0 8px 0; font-size: 18px;">Custom Content</h4>
            <p style="margin: 0; font-size: 12px;">This annotation has custom HTML!</p>
        </div>
    `;

    viewer.addAnnotation({
        id: 'annotation-3',
        imageId: 'test',
        fixed: true,
        x: image.width * 0.65,
        y: image.height * 0.65,
        width: image.width * 0.25,
        height: image.height * 0.18,
        style: {
            border: '3px solid #9b59b6',
            backgroundColor: 'rgba(155, 89, 182, 0.3)',
            borderRadius: '12px'
        },
        content: {
            element: customElement
        },
        scaleWithZoom: true
    });

    console.log('✓ Demo annotations added!');
    console.log('  - Try: viewer.annotationManager.clearAllAnnotations()');
}

*/
