import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const root=new URL('../',import.meta.url);
const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
if(process.argv[2]==='lock'){
  // npm deliberately omits package-lock.json from published tarballs.
  await copyFile(new URL('package-lock.json',root),new URL('npm-shrinkwrap.json',root));
}else if(process.argv[2]==='manifest'){
  const name=`${pkg.name}-${pkg.version}.tgz`,directory=resolve(process.argv[3]||'dist');
  const bytes=await readFile(resolve(directory,name)),sha256=createHash('sha256').update(bytes).digest('hex');
  await writeFile(resolve(directory,'update.json'),JSON.stringify({format:1,version:pkg.version,stateSchema:1,minNodeMajor:22,archive:{name,sha256,bytes:bytes.length}},null,2)+'\n');
  await writeFile(resolve(directory,name+'.sha256'),sha256+'  '+name+'\n');
  console.log(JSON.stringify({version:pkg.version,archive:name,sha256,bytes:bytes.length}));
}else throw Error('Use lock or manifest [artifact-directory]');
