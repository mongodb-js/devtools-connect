import type { RedirectServerRequestInfo } from '@mongodb-js/oidc-plugin';
import type { DevtoolsConnectOptions } from '../connect';
import { OIDCAcceptedPage, OIDCNotFoundPage, OIDCErrorPage } from './static/static-pages';

export function oidcServerRequestHandler(
  options: Pick<DevtoolsConnectOptions, 'productDocsLink' | 'productName'>,
  info: RedirectServerRequestInfo
): void {
  const { productDocsLink, productName } = options;
  const { res, result, status } = info;
  res.statusCode = status;
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'");
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  switch (result) {
    case 'accepted':
      res.end(OIDCAcceptedPage({ productDocsLink, productName }));
      break;
    case 'rejected':
      res.end(OIDCErrorPage({ productDocsLink, productName, ...info }));
      break;
    default:
      res.end(OIDCNotFoundPage({ productDocsLink, productName }));
      break;
  }
}
