import { defineConfig } from 'vite';
import laravel from 'laravel-vite-plugin';
import { buildStamp } from './batch/buildStamp.mjs';

export default defineConfig(({ command }) => {
    // Stamped on every /results batch. The dev server's code changes after it starts, so its stamp always counts as dirty.
    const stamp = buildStamp(process.cwd(), command === 'serve' ? 'vite-dev' : 'vite-build');
    if (command === 'serve') stamp.dirty = true;

    return {
        define: {
            __BUILD_STAMP__: JSON.stringify(stamp),
        },
        plugins: [
            laravel({
                input: [
                    'resources/css/app.css',
                    'resources/js/app.js',
                    // One entry per page that needs more than Alpine. Keeping the
                    // simulator's bundle separate means the results dashboard never
                    // ships the canvas code and vice versa.
                    'resources/js/simulator.js',
                    'resources/js/results.js',
                    'resources/js/roadEditor.js',
                    'resources/js/traffic-counter.js',
                ],
                refresh: true,
            }),
        ],
    };
});
