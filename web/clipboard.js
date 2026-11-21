/* Read only the files carried by the user's paste event. */
'use strict';

function collectClipboardImages(clipboard, now = new Date()){
  if(!clipboard || clipboard.getData('text/plain').trim()) return [];
  const formats = {
    'image/png':'png', 'image/jpeg':'jpg', 'image/gif':'gif',
    'image/webp':'webp', 'image/bmp':'bmp', 'image/avif':'avif'
  };
  const pad = n => String(n).padStart(2,'0');
  const date = now.getFullYear() + pad(now.getMonth()+1) + pad(now.getDate());
  const clock = pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
  const pictures = Array.from(clipboard.files).filter(file => file.size && Object.hasOwn(formats,file.type));
  return pictures.map((picture,i) => {
    const suffix = pictures.length > 1 ? '-' + (i+1) : '';
    const name = '剪贴板-' + date + '-' + clock + suffix + '.' + formats[picture.type];
    const file = new File([picture],name,{type:picture.type,lastModified:now.getTime()});
    return {file,name,rel:name};
  });
}

if(typeof module === 'object' && module.exports) module.exports = {collectClipboardImages};
