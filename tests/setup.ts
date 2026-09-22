// Pin only the test locale; runtime formatting still follows the user's locale.
const DateTimeFormat = Intl.DateTimeFormat;
Intl.DateTimeFormat = new Proxy(DateTimeFormat, {
  construct(target, [locales, options]) {
    return new target(locales ?? "en-US", options);
  },
  apply(target, _receiver, [locales, options]) {
    return target(locales ?? "en-US", options);
  },
});
