import { createHash } from 'node:crypto';
import { copyFile,mkdir,readFile,writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname,join,relative,resolve,sep } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';

const mobile=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const moduleDirectory=join(mobile,'modules/joko-linkspan-iroh');
const require=createRequire(join(mobile,'package.json'));
const supportedAndroid=['arm64-v8a','armeabi-v7a','x86_64','x86'];
const supportedIos=['ios-arm64','ios-simulator-arm64','ios-simulator-x64'];

/** Native preparation happens before a selected native app build, never in JS startup. */
export async function prepareMobileLinkspanNative({platform,environment=process.env}={}){
  const selected=(environment.JOKO_LINKSPAN_BUILD_BACKENDS??'').split(',').map(value=>value.trim()).filter(Boolean);
  if(!selected.includes('iroh-native'))return{enabled:false,targets:[]};
  if(!['android','ios'].includes(platform))throw new Error('Choose the native Mobile platform explicitly before preparing iroh.');
  const names=(platform==='android'?environment.JOKO_LINKSPAN_ANDROID_ABIS:environment.JOKO_LINKSPAN_IOS_TARGETS)?.split(',').map(value=>value.trim()).filter(Boolean);
  const targets=names??(platform==='android'?['arm64-v8a','x86_64']:supportedIos);
  const allowed=platform==='android'?supportedAndroid:supportedIos;
  if(targets.length===0||new Set(targets).size!==targets.length||targets.some(value=>!allowed.includes(value)))throw new Error('The selected native iroh target list is invalid.');
  const marker=require.resolve('@jokoagent/linkspan-iroh/native-sources');
  const sources=dirname(marker),configuration=JSON.parse(await readFile(marker,'utf8'));
  const builder=require.resolve('@jokoagent/linkspan-iroh-node/prepare-mobile');
  const builderRoot=resolve(dirname(builder),'..');
  const inputFiles=[builder,join(dirname(builder),'mobile-files.mjs'),join(builderRoot,'mobile-inputs.json'),marker,...configuration[platform].sources.map(value=>join(sources,value))];
  const fingerprint=createHash('sha256');for(const input of inputFiles)fingerprint.update(await readFile(input));fingerprint.update(JSON.stringify(targets));
  const key=fingerprint.digest('hex').slice(0,24),generated=join(moduleDirectory,...(platform==='ios'?['ios','generated']:['generated'])),base=join(generated,platform,key);
  const runtime=join(base,'runtime'),nativeSources=join(base,'sources'),notices=join(base,'notices');
  await mkdir(nativeSources,{recursive:true});await mkdir(notices,{recursive:true});
  const {prepareIrohMobileRuntime}=await import(pathToFileURL(builder).href);
  const prepared=await prepareIrohMobileRuntime({directory:runtime,platform,targets,
    ...(environment.LINKSPAN_CARGO_EXECUTABLE?{cargoExecutable:environment.LINKSPAN_CARGO_EXECUTABLE}:{}),
    ...(environment.LINKSPAN_MOBILE_CACHE_DIR?{cacheDirectory:environment.LINKSPAN_MOBILE_CACHE_DIR}:{})});
  for(const name of configuration[platform].sources){const target=join(nativeSources,name.split('/').at(-1));await copyFile(join(sources,name),target);}
  for(const name of ['THIRD_PARTY_NOTICES.txt','rust-dependencies.json','native-runtime.json'])await copyFile(join(runtime,name),join(notices,name));
  const local=path=>{const value=relative(generated,path);if(value.startsWith('..')||value.startsWith(sep))throw new Error('The native Mobile output escaped its build-owned directory.');return value.split(sep).join('/');};
  const selection={platform,targets,runtimeDirectory:local(runtime),sourceDirectory:local(nativeSources),noticeDirectory:local(notices),receiptSha256:createHash('sha256').update(await readFile(join(runtime,'native-runtime.json'))).digest('hex')};
  await writeFile(join(generated,`${platform}-selection.json`),JSON.stringify(selection,null,2)+'\n');
  return{enabled:true,targets,receipt:prepared.receipt};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await prepareMobileLinkspanNative({platform:process.argv[2]})));
