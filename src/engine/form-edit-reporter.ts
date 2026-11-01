/**
 * Reports a form edit once per page URL: `send` fires on the first input and again after the (same-document) URL changes.
 * The worker clears its flag on URL change, so the page must be able to flag itself again.
 */
export function createFormEditReporter(getHref: () => string, send: () => void): () => void {
  let reportedHref: string | undefined;
  return () => {
    const href = getHref();
    if (reportedHref === href) return;
    reportedHref = href;
    send();
  };
}
