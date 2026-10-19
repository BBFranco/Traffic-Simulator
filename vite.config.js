import { defineConfig } from 'vite';
import laravel from 'laravel-vite-plugin';
import { buildStamp } from './batch/buildStamp.mjs';

export default defineConfig(({ command }) => {
    // Stamped on every /results batch. The dev server's code changes after it starts, so its baked stamp counts as dirty -
    // a batch fetches a fresh one from /__build-stamp below, and only falls back to this when it can't.
    const stamp = buildStamp(process.cwd(), command === 'serve' ? 'vite-dev' : 'vite-build');
    if (command === 'serve') stamp.dirty = true;

    return {
        define: {
            __BUILD_STAMP__: JSON.stringify(stamp),
        },
        plugins: [
            {
                // The dev server's code is the working tree as it is now, so a /results batch asks for a fresh stamp
                // when it starts (results.js's currentBuildStamp()) instead of trusting the one taken at server start.
                name: 'build-stamp',
                configureServer(server) {
                    server.middlewares.use('/__build-stamp', (req, res) => {
                        res.setHeader('Content-Type', 'application/json');
                        // fresh: checked at batch start - the report tells it apart from the baked always-dirty stamp.
                        res.end(JSON.stringify({ ...buildStamp(process.cwd(), 'vite-dev'), fresh: true }));
                    });
                },
            },
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
