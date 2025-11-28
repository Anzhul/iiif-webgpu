import './style.scss'
import { IIIFViewer } from './IIIF/iiif';
import { gsap } from 'gsap';

const container = document.getElementById('iiif-container');
if (container) {
    const viewer = new IIIFViewer(container, {
        toolbar: { 
            zoom: true,
            annotations: true,
            layers: true,
            CVButton: true,
            fullscreen: true,
            world: true,
        },
        gsap: gsap
    });
    viewer.addImage({
        id: 'test',
        url: 'https://free.iiifhosting.com/iiif/616bc3c8dc9a69d3e935139c8c77b76f32137cab7ce0e4fd2166507cdc948b/info.json',
        x: 0,
        y: 0,
        z: 0,
        scale: 1.0,
        rotation: 0,
        detail: 1.0 //adjust this for how much detail to load
    })
    .then(() => {
        console.log('Image loaded successfully');
    })
    .catch((error) => {
        console.error('Error loading or rendering:', error);
    });

    viewer.addGroup({
        id: 'test-group',
        images: [{
            id: 'test2', 
            url: 'https://free.iiifhosting.com/iiif/616bc3c8dc9a69d3e935139c8c77b76f32137cab7ce0e4fd2166507cdc948b/info.json',
            x: 0,
            y: 0,
            z: 0,
            scale: 1.0,
            rotation: 0,
            detail: 1.0
        }],
        x: 0,
        y: 0,
        z: 0,
        scale: 1.0,
        rotation: 0,
    });

    viewer.move({
        object: 'test',
        to: 'test-group'
    });

    viewer.startRenderLoop('test');

    viewer.camera.zoomToFit({id: 'test',})
} 
else {
    console.error('Container element not found');
}