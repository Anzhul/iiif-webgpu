import './style.scss'
import { IIIFViewer } from './IIIF/iiif';

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
    if (!viewer.overlayManager) {
        console.log('Overlay manager not available');
        return;
    }

    const image = viewer.images.get('test');
    if (!image) return;

    console.log('Adding demo overlays...');
    console.log(`Image dimensions: ${image.width}x${image.height}`);

    // Add a highlight box in the center
    const box = document.createElement('div');
    box.style.backgroundColor = 'rgba(255, 0, 0, 0.3)';
    box.style.border = '3px solid red';
    box.style.boxSizing = 'border-box';

    viewer.overlayManager.addOverlay({
        id: 'demo-box',
        element: box,
        imageX: image.width * 0.3,
        imageY: image.height * 0.3,
        imageWidth: image.width * 0.4,
        imageHeight: image.height * 0.4,
        imageId: 'test',
        scaleWithZoom: true
    });

    // Add a label
    const label = document.createElement('div');
    label.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
    label.style.color = 'white';
    label.style.padding = '12px 16px';
    label.style.borderRadius = '6px';
    label.style.fontSize = '16px';
    label.style.fontFamily = 'Arial, sans-serif';
    label.style.fontWeight = 'bold';
    label.textContent = 'Demo Overlay - Pan and Zoom!';

    viewer.overlayManager.addOverlay({
        id: 'demo-label',
        element: label,
        imageX: image.width * 0.1,
        imageY: image.height * 0.1,
        imageWidth: image.width * 0.15,
        imageHeight: image.height * 0.05,
        imageId: 'test',
        scaleWithZoom: true
    });

    // Add a fixed-size marker
    const marker = document.createElement('div');
    marker.style.width = '30px';
    marker.style.height = '30px';
    marker.style.backgroundColor = '#00ff00';
    marker.style.borderRadius = '50%';
    marker.style.border = '3px solid white';
    marker.style.boxShadow = '0 2px 8px rgba(0,0,0,0.5)';

    viewer.overlayManager.addOverlay({
        id: 'demo-marker',
        element: marker,
        imageX: image.width * 0.7,
        imageY: image.height * 0.2,
        imageWidth: 30,
        imageHeight: 30,
        imageId: 'test',
        scaleWithZoom: false  // This marker stays the same size
    });

    console.log('✓ Demo overlays added! Try panning and zooming to see them move.');
    console.log('To remove overlays: viewer.overlayManager.clearAllOverlays()');
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