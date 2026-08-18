{{--
    Applies the stored theme before first paint, so night mode never flashes white
    (or the reverse) while the JS bundle loads. Light is the default: the OS
    preference is deliberately ignored until the user picks a theme themselves.
    resources/js/theme.js takes over from here.
--}}
<script>
    (function () {
        var theme = 'light';
        try {
            var stored = localStorage.getItem('theme');
            if (stored === 'dark' || stored === 'light') theme = stored;
        } catch (e) { /* storage blocked - fall back to light */ }

        var root = document.documentElement;
        if (theme === 'dark') root.classList.add('dark');
        root.dataset.theme = theme;
        root.style.colorScheme = theme;
    })();
</script>
