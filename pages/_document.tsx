import { Html, Head, Main, NextScript } from "next/document";

// Sets <html data-theme> from the saved choice BEFORE first paint, so there's no light/dark
// flash. Defaults to dark (the concept bank's heritage) unless the user has toggled to light.
const NO_FLASH = `(function(){try{var k=localStorage.getItem('cb-theme');var t=(k==='light'||k==='dark')?k:'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function Document() {
  return (
    <Html lang="en" data-theme="dark">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
