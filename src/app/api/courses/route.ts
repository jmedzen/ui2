import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function getDatabasePath(): string {
  const dataDbPath = path.join(process.cwd(), 'data', 'courses_db.json');
  const srcDbPath = path.join(process.cwd(), 'src', 'data', 'courses_db.json');

  if (!fs.existsSync(dataDbPath) && fs.existsSync(srcDbPath)) {
    try {
      const dataDir = path.dirname(dataDbPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.copyFileSync(srcDbPath, dataDbPath);
    } catch (e) {
      console.warn('Failed to initialize data/courses_db.json:', e);
      return srcDbPath;
    }
  }

  return fs.existsSync(dataDbPath) ? dataDbPath : srcDbPath;
}

export async function GET(request: Request) {
  try {
    const filePath = getDatabasePath();
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'Database file not found' }, { status: 404 });
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    const db = JSON.parse(data);

    return new NextResponse(JSON.stringify(db), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
      }
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
