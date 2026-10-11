import { createRootRoute, HeadContent, Scripts } from '@tanstack/react-router';
import App from '@/App';
import appCss from '@/index.css?url';

const assetUrl = (path: string) =>
  `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}${path.replace(/^\//, '')}`;

export const Route = createRootRoute({
  head: () => ({
    meta: [{ title: 'IrisCAD' }],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
  errorComponent: ({ error }) => (
    <RootDocument>
      <App error={error} />
    </RootDocument>
  ),
});

function RootComponent() {
  return (
    <RootDocument>
      <App />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, viewport-fit=cover"
        />
        <link rel="icon" href={assetUrl('iris-favicon.ico')} sizes="any" />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href={assetUrl('iris-logo-32.png')}
        />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href={assetUrl('iris-logo-180.png')}
        />
        <link
          rel="preload"
          as="image"
          type="image/webp"
          href={assetUrl('iris-agent-active.webp')}
          fetchPriority="low"
        />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
