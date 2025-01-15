// basePath.js
function getPreviewBasePath() {
  if (typeof process !== 'undefined' && process.env) {
    // Node.js environment (e.g., during the build process)
    return process.env.REACT_APP_PREVIEW_BASE
      ? `/push-comms-website/pr-preview/${process.env.REACT_APP_PREVIEW_BASE}`
      : '';
  }
  return '';
}

module.exports = { getPreviewBasePath };
