import { defineConfig } from 'vite';
import laravel from 'laravel-vite-plugin';

export default defineConfig({
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
                'resources/js/builder.js',
            ],
            refresh: true,
        }),
    ],
});
