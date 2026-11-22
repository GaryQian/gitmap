// Image plug-in: pictures and icons as assets. Nothing is scanned; other files' imports, `url()`s
// and `<img src>`s link to them, and their spheres are sized by bytes (shared/sizeLines).
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { IMAGE_LANG, languageColor } from '../../shared';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp'];

const image: LanguagePlugin = {
  id: IMAGE_LANG,
  name: 'Image',
  extensions: IMAGE_EXTENSIONS,
  color: languageColor(IMAGE_LANG, config.visual),
  scan: () => ({ imports: [] }),
};

export default image;
