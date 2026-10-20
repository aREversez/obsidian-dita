// esbuild inlines these as strings (loader: text).
declare module '*.css' {
  const css: string;
  export default css;
}
