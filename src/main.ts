import './style.scss'
import { IIIFViewer } from './IIIF/iiif';

const container = document.getElementById('iiif-container');
if (container) {
    const viewer = new IIIFViewer(container);
    //viewer.addControls();
    viewer.listen('test');
    viewer.addImage('test','https://free.iiifhosting.com/iiif/616bc3c8dc9a69d3e935139c8c77b76f32137cab7ce0e4fd2166507cdc948b/info.json')
        .then(() => {
            console.log('Image loaded successfully');
            viewer.startRenderLoop('test');
        })
        .catch((error) => {
            console.error('Error loading or rendering:', error);
        });
    } else {
    console.error('Container element not found');
}