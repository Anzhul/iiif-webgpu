import './style.scss'
import { IIIFViewer } from '../src/IIIF/iiif';
import type { ViewerConfig } from '../src/IIIF/types';

const container = document.getElementById('iiif-container');
if (container) {
    const params = new URLSearchParams(window.location.search);
    const manifestUrl = params.get('manifest');
    const configParam = params.get('config'); // URL to a config JSON file

    const defaultManifest = 'https://iiif.harvardartmuseums.org/manifests/object/299843';
    const url = manifestUrl ?? defaultManifest;

    const viewer = new IIIFViewer(container, {
        panels: {
            settings: 'show-closed',
            navigation: 'show',
            pages: 'show',
            manifest: 'show-closed',
            annotations: 'show',
            compare: 'show',
            gesture: 'show-closed'
        },
        enableOverlays: true
    });

    // Expose viewer globally for debugging/testing
    (window as any).viewer = viewer;

    viewer.listen();
    viewer.startRenderLoop();

    // Load from config JSON URL if provided, otherwise use manifest URL
    const loadPromise = configParam
        ? fetch(configParam)
            .then(res => res.json())
            .then((config: ViewerConfig) => viewer.loadConfig(config))
        : viewer.loadUrl(url);

    loadPromise
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

            // Shared popup content for demos
            const popupContent = document.createElement('div');
            popupContent.innerHTML = `
                <h4>Point of Interest</h4>
                <img src="https://iiif.harvardartmuseums.org/manifests/object/299843/canvas/canvas-47174896/thumbnail" alt="Detail thumbnail" />
                <p>This area shows a detail from the artwork. Click the marker again or elsewhere to dismiss.</p>
                <a href="https://harvardartmuseums.org" target="_blank">Learn more</a>
            `;

            // Custom HTML element annotation with continuous animation
            const hotspot = document.createElement('div');
            hotspot.innerHTML = `
                <div style="
                    width: 40px; height: 40px;
                    background: radial-gradient(circle, #ffffff, #ffffff7a);
                    border-radius: 50%;
                    border: 2px solid rgba(255, 255, 255, 0);
                    animation: iiif-ann-pulse 2s ease-in-out infinite;
                "></div>
            `;
            viewer.addAnnotation(800, 600, 0, 0, hotspot, {
                targetUrl: url,
                targetPage: 0,
                id: 'hotspot-1',
                type: 'Hotspots',
                color: '#965a5a',
                scaleWithZoom: true,
                style: { overflow: 'visible' },
                activeClass: 'iiif-ann-fade-in',
                inactiveClass: 'iiif-ann-fade-out',
                popup: popupContent,
                popupPosition: { x: 48, y: 0 },
            });

            // Slide + fade transition (fixed-size pin with rich popup)
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
                popup: popupContent,
                popupPosition: { x: 28, y: 0 },
            });
        })
        .catch((error) => console.error('Error loading:', error));
}
