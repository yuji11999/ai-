/** UI presets mapped to actual Images API pixel sizes; 1K is a UI tier label. */
export const IMAGE_RATIO_PRESETS = [
  { ratio: '自动', size: 'auto' },
  { ratio: '1:1', size: '1024x1024' },
  { ratio: '2:3', size: '1024x1536' },
  { ratio: '3:2', size: '1536x1024' },
  { ratio: '3:4', size: '864x1152' },
  { ratio: '4:3', size: '1152x864' },
  { ratio: '9:16', size: '864x1536' },
  { ratio: '16:9', size: '1536x864' },
] as const;
