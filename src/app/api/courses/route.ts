import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(request: Request) {
  try {
    const filePath = path.join(process.cwd(), 'src', 'data', 'courses_db.json');
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'Database file not found' }, { status: 404 });
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    const db = JSON.parse(data);
    return NextResponse.json(db);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
