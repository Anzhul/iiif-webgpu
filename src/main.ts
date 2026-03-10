import './style.scss'
import { IIIFViewer } from './IIIF/iiif';

const container = document.getElementById('iiif-container');
if (container) {
    const params = new URLSearchParams(window.location.search);
    const manifestUrl = params.get('manifest');

    const defaultManifest = 'https://iiif.harvardartmuseums.org/manifests/object/299843';
    const url = manifestUrl ?? defaultManifest;

    const viewer = new IIIFViewer(container, {
        toolbar: {
            zoom: true,
            info: true,
            compare: true,
            fullscreen: true
        },
        panels: {
            settings: 'show-closed',
            navigation: 'show',
            pages: 'show',
            manifest: 'show-closed',
            annotations: 'show',
            compare: 'hide',
            gesture: 'show'
        },
        enableOverlays: true
    });

    // Expose viewer globally for debugging/testing
    (window as any).viewer = viewer;

    viewer.listen();
    viewer.startRenderLoop();

    viewer.loadUrl(url)
        .catch((error) => console.error('Error loading:', error));
}
