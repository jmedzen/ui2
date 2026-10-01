import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

// Mirror sortVolumes function from CourseDetail
function sortVolumes(vols: string[]): string[] {
  return [...vols].sort((a, b) => {
    const isSpecialA = /初發|序|概說/.test(a);
    const isSpecialB = /初發|序|概說/.test(b);
    if (isSpecialA && !isSpecialB) return -1;
    if (!isSpecialA && isSpecialB) return 1;

    const getNum = (str: string) => {
      if (str.includes('13-2')) return 13.5;
      const m = str.match(/\d+/);
      return m ? parseFloat(m[0]) : 9999;
    };

    const numA = getNum(a);
    const numB = getNum(b);
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
}

const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.wma', '.flac', '.mp4', '.m4v', '.webm', '.mov'];
const VIDEO_EXTS = ['.mp4', '.m4v', '.wmv', '.flv', '.mov', '.avi', '.mkv', '.webm', '.mpg', '.mpeg'];

function extractFilename(item: any): string {
  if (typeof item === 'string') return item;
  if (item && typeof item.name === 'string') return item.name;
  return String(item || '');
}

function parseMultiVolumeAudio(
  basePath: string,
  dataObj: Record<string, any>
): { filename: string; volume: string; displayName: string; fullPath: string }[] {
  const sortedVols = sortVolumes(Object.keys(dataObj));
  const parsedTracks: { filename: string; volume: string; displayName: string; fullPath: string }[] = [];

  sortedVols.forEach((vol) => {
    const vData = dataObj[vol];
    let audioList: any[] = [];
    let audioSubfolder = 'audio';

    if (Array.isArray(vData)) {
      audioList = vData;
      audioSubfolder = '';
    } else if (vData && typeof vData === 'object') {
      if (Array.isArray(vData.audio)) {
        audioList = vData.audio;
        audioSubfolder = 'audio';
      } else {
        for (const subKey of Object.keys(vData)) {
          if (Array.isArray(vData[subKey])) {
            const sample = vData[subKey][0];
            if (typeof sample === 'string' && AUDIO_EXTS.some((ext: string) => sample.toLowerCase().endsWith(ext))) {
              audioList = vData[subKey];
              audioSubfolder = subKey;
              break;
            }
          }
        }
      }
    }

    const validFiles = audioList
      .map(extractFilename)
      .filter((fn: string) => AUDIO_EXTS.includes('.' + fn.split('.').pop()?.toLowerCase()))
      .sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    validFiles.forEach((fn: string) => {
      const subPath = audioSubfolder ? `${vol}/${audioSubfolder}/${fn}` : `${vol}/${fn}`;
      parsedTracks.push({
        filename: fn,
        volume: vol,
        displayName: `[${vol}] ${fn}`,
        fullPath: `${basePath}/${subPath}`
      });
    });
  });

  return parsedTracks;
}

function parseMultiVolumeVideos(
  basePath: string,
  dataObj: Record<string, any>
): { filename: string; volume: string; displayName: string; fullPath: string }[] {
  const sortedVols = sortVolumes(Object.keys(dataObj));
  const parsedVideos: { filename: string; volume: string; displayName: string; fullPath: string }[] = [];

  sortedVols.forEach((vol) => {
    const vData = dataObj[vol];
    let videoList: any[] = [];
    let videoSubfolder = 'video';

    if (Array.isArray(vData)) {
      videoList = vData;
      videoSubfolder = '';
    } else if (vData && typeof vData === 'object') {
      if (Array.isArray(vData.video)) {
        videoList = vData.video;
        videoSubfolder = 'video';
      } else {
        for (const subKey of Object.keys(vData)) {
          if (Array.isArray(vData[subKey])) {
            const sample = vData[subKey][0];
            if (typeof sample === 'string' && VIDEO_EXTS.some((ext: string) => sample.toLowerCase().endsWith(ext))) {
              videoList = vData[subKey];
              videoSubfolder = subKey;
              break;
            }
          }
        }
      }
    }

    const validVideos = videoList
      .map(extractFilename)
      .filter((fn: string) => VIDEO_EXTS.includes('.' + fn.split('.').pop()?.toLowerCase()))
      .sort((a: string, b: string) => {
        const baseA = a.substring(0, a.lastIndexOf('.')) || a;
        const baseB = b.substring(0, b.lastIndexOf('.')) || b;
        const numsA = baseA.match(/\d+/g);
        const numsB = baseB.match(/\d+/g);
        const numA = numsA ? parseInt(numsA[numsA.length - 1], 10) : 99999;
        const numB = numsB ? parseInt(numsB[numsB.length - 1], 10) : 99999;
        if (numA !== numB) return numA - numB;
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
      });

    validVideos.forEach((fn: string) => {
      const subPath = videoSubfolder ? `${vol}/${videoSubfolder}/${fn}` : `${vol}/${fn}`;
      parsedVideos.push({
        filename: fn,
        volume: vol,
        displayName: `[${vol}] ${fn}`,
        fullPath: `${basePath}/${subPath}`
      });
    });
  });

  return parsedVideos;
}

function parseMultiVolumePdfs(
  basePath: string,
  dataObj: Record<string, any>
): { filename: string; displayName: string; fullUrl: string }[] {
  const sortedVols = sortVolumes(Object.keys(dataObj));
  const parsedPdfs: { filename: string; displayName: string; fullUrl: string }[] = [];

  sortedVols.forEach((vol) => {
    const val = dataObj[vol];
    if (val && typeof val === 'object') {
      const pdfList = Array.isArray(val)
        ? val
        : (Array.isArray(val.bilu) ? val.bilu : (Array.isArray(val.pdf) ? val.pdf : []));
      
      pdfList.forEach((item: any) => {
        const fname = extractFilename(item);
        if (fname.toLowerCase().endsWith('.pdf')) {
          parsedPdfs.push({
            filename: fname,
            displayName: `[${vol}] ${fname}`,
            fullUrl: `https://www.fayun.org/ftpadmin${basePath}/${vol}/bilu/${fname}`
          });
        }
      });
    }
  });

  return parsedPdfs;
}

test('Multi-Volume Course Parsing & Course 97 Integrity Suite', async (t) => {
  const srcDbPath = path.join(process.cwd(), 'src', 'data', 'courses_db.json');
  const dataDbPath = path.join(process.cwd(), 'data', 'courses_db.json');

  const dataDir = path.dirname(dataDbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(dataDbPath) && fs.existsSync(srcDbPath)) {
    fs.copyFileSync(srcDbPath, dataDbPath);
  }

  await t.test('Course 97 database integrity in src/data/courses_db.json', () => {
    const db = JSON.parse(fs.readFileSync(srcDbPath, 'utf-8'));
    const c97 = db.courses.find((c: any) => c.id === 97);

    assert.ok(c97, 'Course 97 must exist');
    assert.strictEqual(c97.id, 97);
    assert.ok(c97.name.includes('本地分'), 'Course 97 must be 本地分');
    assert.strictEqual(
      c97.audio_path,
      '/media/釋論/瑜伽師地論・本地分',
      'Course 97 audio_path must be correctly overridden'
    );
    assert.strictEqual(
      c97.video_path,
      '/media/釋論/瑜伽師地論・本地分',
      'Course 97 video_path must point to 本地分 directory'
    );
    assert.strictEqual(
      c97.lecture_path,
      '/media/釋論/瑜伽師地論・本地分',
      'Course 97 lecture_path must be correctly overridden'
    );
    assert.ok(Array.isArray(c97.pdfs), 'Course 97 must contain pdfs array');
    assert.strictEqual(c97.pdfs.length, 503, 'Course 97 must have all 503 PDFs parsed');

    // First PDF: [初發論端] T0.pdf
    assert.strictEqual(c97.pdfs[0].filename, '[初發論端] T0.pdf');
    assert.ok(c97.pdfs[0].url.includes('/初發論端/bilu/T0.pdf'));

    // Last PDF: [卷50] T478.pdf
    assert.strictEqual(c97.pdfs[502].filename, '[卷50] T478.pdf');
    assert.ok(c97.pdfs[502].url.includes('/卷50/bilu/T478.pdf'));
  });

  await t.test('Course 97 database integrity in data/courses_db.json', () => {
    const db = JSON.parse(fs.readFileSync(dataDbPath, 'utf-8'));
    const c97 = db.courses.find((c: any) => c.id === 97);

    assert.ok(c97, 'Course 97 must exist in data/courses_db.json');
    assert.strictEqual(c97.audio_path, '/media/釋論/瑜伽師地論・本地分');
    assert.strictEqual(c97.video_path, '/media/釋論/瑜伽師地論・本地分');
    assert.strictEqual(c97.pdfs.length, 503);
  });

  await t.test('scan_fayun.py PATH_OVERRIDES preserves Course 97 configuration', () => {
    const scannerPath = path.join(process.cwd(), 'scripts', 'scan_fayun.py');
    const content = fs.readFileSync(scannerPath, 'utf-8');

    assert.ok(content.includes('97: {'), 'Scanner must contain override for Course 97');
    assert.ok(
      content.includes('"video_path": "/media/釋論/瑜伽師地論・本地分"'),
      'Scanner override must specify correct video_path'
    );
  });

  await t.test('sortVolumes sorts introductory volume first and handles complex volume numbers', () => {
    const inputVolumes = [
      '卷50',
      '卷14',
      '卷01',
      '卷13-2',
      '初發論端',
      '卷12至13-1',
      '卷02',
      '卷11'
    ];

    const sorted = sortVolumes(inputVolumes);

    assert.deepStrictEqual(sorted, [
      '初發論端',
      '卷01',
      '卷02',
      '卷11',
      '卷12至13-1',
      '卷13-2',
      '卷14',
      '卷50'
    ]);
  });

  await t.test('parseMultiVolumeAudio handles multi-volume object from fayun API', () => {
    const mockApiResponse = {
      '卷01': {
        audio: ['瑜伽師地論-001a.m4a', '瑜伽師地論-001b.m4a'],
        bilu: ['T1.pdf']
      },
      '初發論端': {
        audio: ['瑜伽師地論-000a.m4a'],
        bilu: ['T0.pdf']
      },
      '卷02': {
        audio: ['瑜伽師地論-002.m4a']
      }
    };

    const tracks = parseMultiVolumeAudio('/media/釋論/瑜伽師地論・本地分', mockApiResponse);

    assert.strictEqual(tracks.length, 4);
    // 初發論端 should be ordered first
    assert.strictEqual(tracks[0].volume, '初發論端');
    assert.strictEqual(tracks[0].displayName, '[初發論端] 瑜伽師地論-000a.m4a');
    assert.strictEqual(
      tracks[0].fullPath,
      '/media/釋論/瑜伽師地論・本地分/初發論端/audio/瑜伽師地論-000a.m4a'
    );

    // Followed by 卷01
    assert.strictEqual(tracks[1].volume, '卷01');
    assert.strictEqual(tracks[1].displayName, '[卷01] 瑜伽師地論-001a.m4a');
    assert.strictEqual(tracks[2].displayName, '[卷01] 瑜伽師地論-001b.m4a');

    // Followed by 卷02
    assert.strictEqual(tracks[3].volume, '卷02');
    assert.strictEqual(tracks[3].displayName, '[卷02] 瑜伽師地論-002.m4a');
  });

  await t.test('parseMultiVolumeVideos parses and naturally orders video files across volumes', () => {
    const mockApiResponse = {
      '卷12至13-1': {
        video: ['155.m4v', '130.m4v']
      },
      '初發論端': {
        video: ['W01.瑜伽師地論-初發論端-02.mp4', 'W01.瑜伽師地論-初發論端-01.mp4']
      },
      '卷01': {
        video: ['W02.瑜伽師地論-卷一-09.mp4', 'W02.瑜伽師地論-卷一-08.mp4']
      }
    };

    const videos = parseMultiVolumeVideos('/media/釋論/瑜伽師地論・本地分', mockApiResponse);

    assert.strictEqual(videos.length, 6);
    // Episode 1
    assert.strictEqual(videos[0].volume, '初發論端');
    assert.strictEqual(videos[0].displayName, '[初發論端] W01.瑜伽師地論-初發論端-01.mp4');
    assert.strictEqual(
      videos[0].fullPath,
      '/media/釋論/瑜伽師地論・本地分/初發論端/video/W01.瑜伽師地論-初發論端-01.mp4'
    );

    // Episode 2
    assert.strictEqual(videos[1].displayName, '[初發論端] W01.瑜伽師地論-初發論端-02.mp4');

    // Episode 8
    assert.strictEqual(videos[2].volume, '卷01');
    assert.strictEqual(videos[2].displayName, '[卷01] W02.瑜伽師地論-卷一-08.mp4');

    // Episode 9
    assert.strictEqual(videos[3].displayName, '[卷01] W02.瑜伽師地論-卷一-09.mp4');

    // Episode 130
    assert.strictEqual(videos[4].volume, '卷12至13-1');
    assert.strictEqual(videos[4].displayName, '[卷12至13-1] 130.m4v');

    // Episode 155
    assert.strictEqual(videos[5].displayName, '[卷12至13-1] 155.m4v');
  });

  await t.test('parseMultiVolumePdfs extracts all PDFs across volumes', () => {
    const mockApiResponse = {
      '卷01': {
        audio: ['瑜伽師地論-001a.m4a'],
        bilu: ['T1.pdf']
      },
      '初發論端': {
        audio: ['瑜伽師地論-000a.m4a'],
        bilu: ['T0.pdf']
      },
      '卷02': {
        audio: ['瑜伽師地論-002.m4a'],
        bilu: ['T2.pdf']
      }
    };

    const pdfs = parseMultiVolumePdfs('/media/釋論/瑜伽師地論・本地分', mockApiResponse);

    assert.strictEqual(pdfs.length, 3);
    assert.strictEqual(pdfs[0].displayName, '[初發論端] T0.pdf');
    assert.strictEqual(
      pdfs[0].fullUrl,
      'https://www.fayun.org/ftpadmin/media/釋論/瑜伽師地論・本地分/初發論端/bilu/T0.pdf'
    );
    assert.strictEqual(pdfs[1].displayName, '[卷01] T1.pdf');
    assert.strictEqual(pdfs[2].displayName, '[卷02] T2.pdf');
  });
});
