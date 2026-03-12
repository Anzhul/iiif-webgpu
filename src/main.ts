import './style.scss'
import { IIIFViewer } from './IIIF/iiif';

const container = document.getElementById('iiif-container');
if (container) {
    const params = new URLSearchParams(window.location.search);
    const manifestUrl = params.get('manifest');

    //const defaultManifest = 'https://iiif.harvardartmuseums.org/manifests/object/299843';
    const defaultManifest = 'https://free.iiifhosting.com/iiif/616bc3c8dc9a69d3e935139c8c77b76f32137cab7ce0e4fd2166507cdc948b';
    const url = manifestUrl ?? defaultManifest;

    const viewer = new IIIFViewer(container, {
        panels: {
            settings: 'show-closed',
            navigation: 'show',
            pages: 'show',
            manifest: 'show-closed',
            annotations: 'show',
            compare: 'show',
            gesture: 'show'
        },
        enableOverlays: true
    });

    // Expose viewer globally for debugging/testing
    (window as any).viewer = viewer;

    viewer.listen();
    viewer.startRenderLoop();

    viewer.loadUrl(url)
        .then(() => {
            // Custom HTML annotations (coordinates are in image pixels)

            // Fade transition
            viewer.addAnnotation(200, 100, 400, 60, 'Detail of interest', {
                targetUrl: url, // Only show on this manifest
                targetPage: 0, // Only show on the first canvas
                id: 'label-1',
                type: 'Detail Notes',
                color: '#3e73c9',
                style: {
                    backgroundColor: 'rgba(0, 0, 0, 0.7)',
                    color: '#fff',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    fontSize: '14px',
                    fontFamily: 'sans-serif',
                },
                activeClass: 'iiif-ann-fade-in',
                inactiveClass: 'iiif-ann-fade-out',
            });

            // Scale + fade transition
            const card = document.createElement('div');
            card.innerHTML = `
                <strong>Annotation Title</strong>
                <p style="margin:4px 0 0;font-size:12px;opacity:0.8;">
                    Click or hover for more info
                </p>
            `;
            card.style.cssText = `
                background: rgba(30, 60, 120, 0.85);
                color: #fff;
                padding: 10px 14px;
                border-radius: 8px;
                font-family: sans-serif;
                font-size: 13px;
                border: 1px solid rgba(255,255,255,0.2);
                cursor: pointer;
            `;
            viewer.addAnnotation(800, 600, 250, 80, card, {
                targetUrl: url,
                targetPage: 0, // Only show on the first canvas
                id: 'card-1',
                type: 'Detail Notes',
                activeClass: 'iiif-ann-scale-in',
                inactiveClass: 'iiif-ann-scale-out',
            });

            // Slide + fade transition (fixed-size pin)
            viewer.addAnnotation(1200, 400, 0, 0, '📍', {
                targetUrl: url,
                targetPage: 0, // Only show on the first canvas
                id: 'pin-1',
                type: 'Markers',
                color: '#4caf50',
                scaleWithZoom: false,
                style: { fontSize: '24px', overflow: 'visible' },
                activeClass: 'iiif-ann-slide-in',
                inactiveClass: 'iiif-ann-slide-out',
            });
        })
        .catch((error) => console.error('Error loading:', error));
}
