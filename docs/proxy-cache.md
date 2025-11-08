# Proxy Cache

The proxy cache enables "airplane mode", where a development server can be used without an internet connection.

It works by caching requests to known Content Delivery Network (CDN) servers, so that they are served from a local cache instead.

(This feature, or a server that provides this feature, are variously referred to on the web as a *proxy cache*, a *reverse proxy cache*, a *caching proxy*, or a *web accelerator*.)

Without the proxy cache:

![Developer console source list, without the proxy cache](without-proxy-cache.png)

With the proxy cache:

![Developer console source list, with the proxy cache](with-proxy-cache.png)

## How to Use the Cache

The proxy cache is designed to be integrated into web servers. To use it, users simply browse their content while connected to the internet. This loads any CDN files that are necessary into the cache. At any later point, users can view the same content without an internet connection.

The cache can also be pre-warmed with the `warm()` method to load common CDN resources.

## Implementation Details

The server rewrites HTML and CSS files, as they are served, to load resources from the server itself instead of from CDN servers. This allows the server to cache these resources, and to serve them without an internet connection.

In HTML documents, the `src` attributes of `script` elements, and the `href` attributes of `link` element with a `type="stylesheet"` attribute, are modified.

In CSS documents, URLs that resolve to CDN resources are also rewritten. This ensures that if the HTML links to a CSS document that in turn includes other CSS documents or other assets (such as fonts or images), these assets are also cached.

A request for `https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js`, for example, is rewritten as a request for `/__proxy_cache/cdn.jsdelivr.net/npm/p5@1.4.0/lib/p5.min.js`. A request for `https://unpkg.com/p5.vector-arguments.min.js` is rewritten as `/__proxy_cache/unpkg.com/p5.vector-arguments.min.js`. This naming scheme makes the source list of the browser's developer console readable.

Status codes and response headers are cached. Each step of a redirect is cached.

The library uses npm's [cacache](https://github.com/npm/cacache) to manage the cache, and [node-html-parser](https://github.com/taoqf/node-fast-html-parser) and [css-tree](https://github.com/csstree/csstree) to parse and re-generate HTML and CSS documents.

## Limitations

The proxy cache ignores the [Cache Control directives](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control). In particular, it caches all CDN content, regardless of the presence of `no-cache`, `no-store`. `must-revalidate`, `proxy-revalidate`, and `no-transform`. In practice, the only directives observed from cached requests to the CDN servers, aside from `max-age` and `s-maxage`, are `immutable`, `public`, and `private`, which don't affect the caching policy.

## References

* [MDN: HTTP Headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers)
* [MDN: Proxy Server](https://developer.mozilla.org/en-US/docs/Glossary/Proxy_server)