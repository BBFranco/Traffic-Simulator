<nav x-data="{ open: false }" class="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
    <div class="w-full px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between h-16">
            <div class="flex">
                <div class="shrink-0 flex items-center gap-3">
                    <a href="{{ route('simulator') }}" class="flex items-center gap-3">
                        <x-application-logo class="h-8 w-auto" />
                        <span class="hidden sm:block text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                            ARTIS
                        </span>
                    </a>
                </div>

                <div class="hidden space-x-8 sm:-my-px sm:ms-10 sm:flex">
                    <x-nav-link :href="route('simulator')" :active="request()->routeIs('simulator')">
                        {{ __('Simulator') }}
                    </x-nav-link>
                    <x-nav-link :href="route('results')" :active="request()->routeIs('results')">
                        {{ __('Results') }}
                    </x-nav-link>
                    <x-nav-link :href="route('road-editor')" :active="request()->routeIs('road-editor')">
                        {{ __('Road Editor') }}
                    </x-nav-link>
                    <x-nav-link :href="route('traffic-counter')" :active="request()->routeIs('traffic-counter')">
                        {{ __('Traffic Counter') }}
                    </x-nav-link>
                </div>
            </div>

            <div class="hidden sm:flex sm:items-center sm:ms-6 sm:gap-2">
                <x-theme-toggle />

                <x-dropdown align="right" width="48">
                    <x-slot name="trigger">
                        <button class="inline-flex items-center gap-1 rounded-md border border-transparent px-3 py-2 text-sm font-medium leading-4 text-slate-500 transition hover:text-slate-900 focus:outline-none dark:text-slate-400 dark:hover:text-slate-100">
                            <div>{{ Auth::user()->name }}</div>
                            <svg class="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                                <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
                            </svg>
                        </button>
                    </x-slot>

                    <x-slot name="content">
                        <x-dropdown-link :href="route('profile.edit')">
                            {{ __('Profile') }}
                        </x-dropdown-link>

                        <form method="POST" action="{{ route('logout') }}">
                            @csrf
                            <x-dropdown-link :href="route('logout')"
                                    onclick="event.preventDefault(); this.closest('form').submit();">
                                {{ __('Log Out') }}
                            </x-dropdown-link>
                        </form>
                    </x-slot>
                </x-dropdown>
            </div>

            <div class="-me-2 flex items-center gap-1 sm:hidden">
                <x-theme-toggle />
                <button @click="open = ! open" class="inline-flex items-center justify-center rounded-md p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200">
                    <svg class="h-6 w-6" stroke="currentColor" fill="none" viewBox="0 0 24 24">
                        <path :class="{'hidden': open, 'inline-flex': ! open }" class="inline-flex" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
                        <path :class="{'hidden': ! open, 'inline-flex': open }" class="hidden" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
        </div>
    </div>

    <div :class="{'block': open, 'hidden': ! open}" class="hidden sm:hidden border-t border-slate-200 dark:border-slate-800">
        <div class="pt-2 pb-3 space-y-1">
            <x-responsive-nav-link :href="route('simulator')" :active="request()->routeIs('simulator')">
                {{ __('Simulator') }}
            </x-responsive-nav-link>
            <x-responsive-nav-link :href="route('results')" :active="request()->routeIs('results')">
                {{ __('Results') }}
            </x-responsive-nav-link>
            <x-responsive-nav-link :href="route('road-editor')" :active="request()->routeIs('road-editor')">
                {{ __('Road Editor') }}
            </x-responsive-nav-link>
            <x-responsive-nav-link :href="route('traffic-counter')" :active="request()->routeIs('traffic-counter')">
                {{ __('Traffic Counter') }}
            </x-responsive-nav-link>
        </div>

        <div class="pt-4 pb-1 border-t border-slate-200 dark:border-slate-800">
            <div class="px-4">
                <div class="font-medium text-base text-slate-900 dark:text-slate-100">{{ Auth::user()->name }}</div>
                <div class="font-medium text-sm text-slate-500 dark:text-slate-400">{{ Auth::user()->email }}</div>
            </div>

            <div class="mt-3 space-y-1">
                <x-responsive-nav-link :href="route('profile.edit')">
                    {{ __('Profile') }}
                </x-responsive-nav-link>

                <form method="POST" action="{{ route('logout') }}">
                    @csrf
                    <x-responsive-nav-link :href="route('logout')"
                            onclick="event.preventDefault(); this.closest('form').submit();">
                        {{ __('Log Out') }}
                    </x-responsive-nav-link>
                </form>
            </div>
        </div>
    </div>
</nav>
