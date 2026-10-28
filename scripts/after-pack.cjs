const fs=require('node:fs/promises');
const path=require('node:path');
const sharp=require('sharp');
const PE=require('resedit');
module.exports=async context=>{
 if(context.electronPlatformName!=='win32')return;
 const file=path.join(context.appOutDir,'轻图.exe');
 const executable=PE.NtExecutable.from(await fs.readFile(file),{ignoreCert:true});
 const resource=PE.NtExecutableResource.from(executable);
 const version=PE.Resource.VersionInfo.fromEntries(resource.entries)[0]??PE.Resource.VersionInfo.createEmpty();
 version.setFileVersion(0,1,0,0,1033);version.setProductVersion(0,1,0,0,1033);
 version.setStringValues({lang:1033,codepage:1200},{FileDescription:'轻图',ProductName:'轻图',InternalName:'QingTu',OriginalFilename:'轻图.exe',CompanyName:'轻图',LegalCopyright:'',FileVersion:'0.1.0',ProductVersion:'0.1.0'});
 version.outputToResourceEntries(resource.entries);
 const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#597cfa"/><stop offset="1" stop-color="#9459f9"/></linearGradient></defs><rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/><circle cx="121" cy="120" r="59" fill="none" stroke="white" stroke-width="20"/><path d="M150 150l42 42" stroke="white" stroke-width="20" stroke-linecap="round"/></svg>');
 const png=await sharp(svg).png().toBuffer();const header=Buffer.alloc(22);
 header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
 const icon=PE.Data.IconFile.from(Buffer.concat([header,png]));
 const groups=PE.Resource.IconGroupEntry.fromEntries(resource.entries);
 for(const group of groups.length?groups:[{id:101,lang:1033}])PE.Resource.IconGroupEntry.replaceIconsForResource(resource.entries,group.id,group.lang,icon.icons.map(x=>x.data));
 resource.outputResource(executable);
 await fs.writeFile(file,Buffer.from(executable.generate()));
 // Read back product metadata; never ship a silently malformed resource edit.
 const verify=PE.NtExecutableResource.from(PE.NtExecutable.from(await fs.readFile(file)));
 const values=PE.Resource.VersionInfo.fromEntries(verify.entries)[0].getStringValues({lang:1033,codepage:1200});
 if(values.ProductName!=='轻图'||values.ProductVersion!=='0.1.0')throw new Error('Windows product resource verification failed');
};
