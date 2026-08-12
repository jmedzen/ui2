import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const filePath = path.join(process.cwd(), 'src', 'data', 'courses_db.json');
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
