declare module '@tailwindcss/forms' {
  import type { Config, PluginCreator } from 'tailwindcss/types/config';

  const forms: {
    (options?: { strategy?: 'base' | 'class' }): {
      handler: PluginCreator;
      config?: Partial<Config> | undefined;
    };
    __isOptionsFunction: true;
  };
  export = forms;
}
