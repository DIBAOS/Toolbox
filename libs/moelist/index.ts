import jszip from "jszip";
import { createExtractorFromData } from "node-unrar-js";
import { FileWithPath } from "@mantine/dropzone";

const version = 'moelist v0.0.1';

export type ArchiveType = 'zip' | 'rar' | 'folder';

export interface Archive {
  name: string;
  size: number;
  type: ArchiveType;
  files?: FileWithPath[];
};

export interface ArchiveInfo {
  name: string;
  size: number;
  exts: string[];
  fileCount: number;
  folderCount: number;
  files?: FileWithPath[];
};

export class ArchiveInfoReader {
  static _wasmBinary: ArrayBuffer;
  private _archive: Archive;

  static async init() {
    const wasmUrl = new URL('node-unrar-js/esm/js/unrar.wasm', import.meta.url);
    const wasmBinary = await (
      await fetch(wasmUrl, { credentials: 'same-origin' })
    ).arrayBuffer();
    ArchiveInfoReader._wasmBinary = wasmBinary;
    console.log('ArchiveInfoReader initialized');
  }

  static async open(archive: Archive): Promise<ArchiveInfo> {
    return new ArchiveInfoReader(archive).readArchiveInfo();
  }

  constructor(archive: Archive) {
    if (!ArchiveInfoReader._wasmBinary) {
      ArchiveInfoReader.init();
    }
    this._archive = archive;
  }

  async readArchiveInfo(): Promise<ArchiveInfo> {
    if (this._archive.type === 'zip') {
      return this.readZipfile();
    } else if (this._archive.type === 'rar') {
      return this.readRarFile();
    } else {
      return this.readFolder();
    }
  }

  async readZipfile(): Promise<ArchiveInfo> {
    const zip = await jszip.loadAsync(this._archive.files![0]);
    const paths = Object.keys(zip.files);

    let fileCount = 0;
    let folderCount = 0;
    let extensions = new Set<string>();
  
    for (let path of paths) {
      if (path.endsWith('/')) {
        folderCount++;
      } else {
        fileCount++;
  
        const ext = path.split('.').pop();
        if (ext) {
          extensions.add(ext);
        }
      }
    }
  
    return {
      name: this._archive.name,
      size: this._archive.size,
      exts: Array.from(extensions),
      fileCount,
      folderCount,
    };
  }

  async readRarFile(): Promise<ArchiveInfo> {
    const data = await this._loadBuffer();
    const extractor = await createExtractorFromData({ wasmBinary: ArchiveInfoReader._wasmBinary, data });
    const { fileHeaders } = extractor.getFileList();

    let fileCount = 0;
    let folderCount = 0;
    let extensions = new Set<string>();

    for (let file of fileHeaders) {
      if (file.flags.directory) {
        folderCount++;
      } else {
        fileCount++;

        const ext = file.name.split('.').pop();
        if (ext) {
          extensions.add(ext);
        }
      }
    }

    return {
      name: this._archive.name,
      size: this._archive.size,
      exts: Array.from(extensions),
      fileCount,
      folderCount,
    };
  }

  async readFolder(): Promise<ArchiveInfo> {
    let extensions = new Set<string>();
    let folderTree = new Map<number, Set<String>>();
    for (let file of this._archive.files!) {
      let paths = file.path!.split('/');
      
      // path's like: /subroot/subfolder/file.ext
      // paths[0] is '', paths[1] is subroot (which means _archive.name is subroot)
      // when length > 3, it should have subfolder, and it's depth is 2 
      if (paths.length > 3) {
        for (let depth = 2; depth < paths.length - 1; depth++) {
          if (!folderTree.has(depth)) {
            folderTree.set(depth, new Set<string>());
          }
          folderTree.get(depth)?.add(paths[depth]);
        }
      }

      const ext = file.name.split('.').pop();
      if (ext) {
        extensions.add(ext);
      }
    }
    let folderCount = 0;
    for (let folders of folderTree.values()) {
      folderCount += folders.size;
    }
    return {
      name: this._archive.name,
      size: this._archive.size,
      exts: Array.from(extensions),
      fileCount: this._archive.files!.length,
      folderCount,
    };
  }

  static async preprocess(files: FileWithPath[]): Promise<Archive[]> {
    let archives: Archive[] = [];
    let others: FileWithPath[] = [];
    for (let file of files) {
      if (file.name.endsWith('.zip')) {
        archives.push({ name: file.name, size: file.size, type: 'zip', files: [file] });
      } else if (file.name.endsWith('.rar')) {
        archives.push({ name: file.name, size: file.size, type: 'rar', files: [file] });
      } else {
        others.push(file);
      }
    }

    let folders = new Map<string, FileWithPath[]>();
    for (let file of others) {
      if (!file.path || !file.path.startsWith('/')) {
        continue;
      }
      let paths = file.path.split('/');
      let folder = paths[1];
      if (!folders.has(folder)) {
        folders.set(folder, []);
      }
      folders.get(folder)?.push(file);
    }
    for (let [name, files] of folders) {
      let totalSize = files.reduce((sum, file) => sum + file.size, 0);
      archives.push({ name, size: totalSize, type: 'folder', files });
    }

    return archives;
  }

  async _loadBuffer(): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((r) => {
      const reader = new FileReader();
      reader.addEventListener('load', (event) => {
        r(event.target?.result as ArrayBuffer);
      });
      reader.readAsArrayBuffer(this._archive.files![0]);
    });
  }
}

export type SizeType = 'XXS' | 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL' | 'XXXL';

export class MoelistFormatter {
  static getSizeType(size: number): SizeType {
    let sizeMB = size / 1024 / 1024;
    if (sizeMB < 20) return 'XXS';
    if (sizeMB < 50) return 'XS';
    if (sizeMB < 100) return 'S';
    if (sizeMB < 175) return 'M';
    if (sizeMB < 300) return 'L';
    if (sizeMB < 500) return 'XL';
    if (sizeMB < 800) return 'XXL';
    return 'XXXL';
  }
  
  static getPreviewStyle(infos: ArchiveInfo[]): string {
    if (infos.length === 0) return '';
  
    let header = '        Size Type Summary                  Extensions   Name';
    let divider = '------------ ---- ------------------------ ------------ ------------------------';

    let totalSize = 0;
    let totalFiles = 0;
    let totalFolders = 0;

    let lines = [header, divider];
    for (let info of infos) {
      let size = info.size.toLocaleString();
      let type = MoelistFormatter.getSizeType(info.size);

      let fileCount = info.fileCount;
      let folderCount = info.folderCount;
      let summary = `${fileCount} files, ${folderCount} folders`;
      let extensions = info.exts.join(', ');
      let name = info.name;

      let line = `${size.padStart(12)} ${type.padStart(4)} ${summary.padEnd(24)} ${extensions.padEnd(12)} ${name}`;
      lines.push(line);

      totalSize += info.size;
      totalFiles += fileCount;
      totalFolders += folderCount;
    }
    lines.push(divider);
    lines.push(`${totalSize.toLocaleString().padStart(12)}      ${totalFiles} files, ${totalFolders} folders`);
    return lines.join('\n');
  }

  static getCodeStyle(infos: ArchiveInfo[]): string {
    if (infos.length === 0) return '';

    let quoteStart = '[quote][font=courier new, courier, monospace]';
    let quoteEnd = '[/font][/quote]';
    let content = MoelistFormatter.getPreviewStyle(infos);
    let lines = [quoteStart, version, content, quoteEnd];

    return lines.join('\n');
  }
  
  static getTableStyle(infos: ArchiveInfo[]): string {
    if (infos.length === 0) return '';

    let quoteStart = '[quote]';
    let quoteEnd = '[/quote]';
    let tableStart = '[table=100%][tr]'+
                    '[td]档案[/td]'+
                    '[td][align=right]体积[/align][/td]'+
                    '[td][align=right]体积类型[/align][/td]'+
                    '[td][align=right]文件数[/align][/td]'+
                    '[td][align=right]文件夹数[/align][/td]'+
                    '[td]扩展名[/td][/tr]';

    let totalSize = 0;
    let totalFiles = 0;
    let totalFolders = 0;

    let lines = [quoteStart, version, tableStart];
    for (let info of infos) {
      let size = info.size.toLocaleString();
      let type = MoelistFormatter.getSizeType(info.size);

      let fileCount = info.fileCount;
      let folderCount = info.folderCount;
      let extensions = info.exts.join(', ');
      let name = info.name;

      let line = `[tr][td]${name}[/td]`+
                 `[td][align=right]${size}[/align][/td]`+
                 `[td][align=right]${type}[/align][/td]`+
                 `[td][align=right]${fileCount}[/align][/td]`+
                 `[td][align=right]${folderCount}[/align][/td]`+
                 `[td]${extensions}[/td][/tr]`;
      lines.push(line);

      totalSize += info.size;
      totalFiles += fileCount;
      totalFolders += folderCount;
    }
    let counter = `[tr][td]总计[/td]`+
                  `[td][align=right]${totalSize.toLocaleString()}[/align][/td]`+
                  `[td][/td]`+
                  `[td][align=right]${totalFiles}[/align][/td]`+
                  `[td][align=right]${totalFolders}[/align][/td]`+
                  `[td][/td][/tr]`+
                  `[/table]`;
    lines.push(counter);
    lines.push(quoteEnd);
    return lines.join('\n');
  }
}

