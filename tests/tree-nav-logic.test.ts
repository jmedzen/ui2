import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

interface CourseItem {
  id: number;
  name: string;
  main_menu: string;
  main_menu_title: string;
  sub_menu: string;
  sub_menu_title: string;
  topic?: string;
  topic_title?: string;
  location?: string;
  time?: string;
  audio_path?: string;
  video_path?: string;
  pdfs?: { filename: string; url: string }[];
}

interface TreeNode {
  id: string;
  label: string;
  type: 'menu' | 'submenu' | 'topic' | 'course';
  children?: TreeNode[];
  count?: number;
  course?: CourseItem;
}

function buildTreeData(courses: CourseItem[], filter: 'all' | 'audio' | 'video' | 'pdf', search: string): TreeNode[] {
  const query = search.trim().toLowerCase();

  const filtered = courses.filter((course) => {
    // 1. Media type filter
    if (filter === 'audio' && !course.audio_path) return false;
    if (filter === 'video' && (!course.video_path || course.video_path.trim() === '')) return false;
    if (filter === 'pdf' && (!course.pdfs || course.pdfs.length === 0)) return false;

    // 2. Text query search
    if (query) {
      const matchName = course.name.toLowerCase().includes(query);
      const matchMain = course.main_menu_title?.toLowerCase().includes(query);
      const matchSub = course.sub_menu_title?.toLowerCase().includes(query);
      const matchTopic = course.topic_title?.toLowerCase().includes(query);
      const matchLoc = course.location?.toLowerCase().includes(query);
      const matchTime = course.time?.toLowerCase().includes(query);
      return matchName || matchMain || matchSub || matchTopic || matchLoc || matchTime;
    }

    return true;
  });

  const rootNodes: TreeNode[] = [];
  const rootMap = new Map<string, TreeNode>();
  const subMap = new Map<string, TreeNode>();
  const topicMap = new Map<string, TreeNode>();

  filtered.forEach((course) => {
    // 1. Main Menu
    let mainNode = rootMap.get(course.main_menu);
    if (!mainNode) {
      mainNode = {
        id: `menu-${course.main_menu}`,
        label: course.main_menu_title,
        type: 'menu',
        children: [],
        count: 0
      };
      rootMap.set(course.main_menu, mainNode);
      rootNodes.push(mainNode);
    }
    mainNode.count = (mainNode.count || 0) + 1;

    // 2. Sub Menu
    const subKey = `${course.main_menu}__${course.sub_menu}`;
    let subNode = subMap.get(subKey);
    if (!subNode) {
      subNode = {
        id: `sub-${course.main_menu}-${course.sub_menu}`,
        label: course.sub_menu_title,
        type: 'submenu',
        children: [],
        count: 0
      };
      subMap.set(subKey, subNode);
      mainNode.children?.push(subNode);
    }
    subNode.count = (subNode.count || 0) + 1;

    // 3. Topic
    const topicLabel = course.topic_title && course.topic_title.trim() !== '' ? course.topic_title : '通用主題';
    const topicKey = `${subKey}__${course.topic || 'default'}`;
    let topicNode = topicMap.get(topicKey);
    if (!topicNode) {
      topicNode = {
        id: `topic-${course.sub_menu}-${course.topic || 'default'}`,
        label: topicLabel,
        type: 'topic',
        children: [],
        count: 0
      };
      topicMap.set(topicKey, topicNode);
      subNode.children?.push(topicNode);
    }
    topicNode.count = (topicNode.count || 0) + 1;

    // 4. Course Leaf
    topicNode.children?.push({
      id: `course-${course.id}`,
      label: course.name,
      type: 'course',
      course
    });
  });

  return rootNodes;
}

test('Tree Navigation Hierarchy & Filtering Suite', async (t) => {
  const dbPath = path.join(process.cwd(), 'src', 'data', 'courses_db.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  const courses: CourseItem[] = db.courses;

  await t.test('builds accurate 4-level hierarchy for all 415 courses', () => {
    const tree = buildTreeData(courses, 'all', '');
    assert.ok(tree.length > 0, 'Tree must contain root categories');

    const totalCount = tree.reduce((acc, node) => acc + (node.count || 0), 0);
    assert.strictEqual(totalCount, 415, 'Total leaf courses across all root nodes must equal 415');

    // Check depth
    for (const root of tree) {
      assert.strictEqual(root.type, 'menu');
      assert.ok(root.children && root.children.length > 0, 'Root node must have submenus');
      for (const sub of root.children!) {
        assert.strictEqual(sub.type, 'submenu');
        assert.ok(sub.children && sub.children.length > 0, 'Submenu must have topics');
        for (const topic of sub.children!) {
          assert.strictEqual(topic.type, 'topic');
          assert.ok(topic.children && topic.children.length > 0, 'Topic must have course leaves');
          for (const leaf of topic.children!) {
            assert.strictEqual(leaf.type, 'course');
            assert.ok(leaf.course, 'Leaf must reference course item');
          }
        }
      }
    }
  });

  await t.test('media filters correctly partition courses', () => {
    const videoTree = buildTreeData(courses, 'video', '');
    const videoCount = videoTree.reduce((acc, node) => acc + (node.count || 0), 0);
    assert.strictEqual(videoCount, 267, 'Video filter must return exactly 267 courses');

    const pdfTree = buildTreeData(courses, 'pdf', '');
    const pdfCount = pdfTree.reduce((acc, node) => acc + (node.count || 0), 0);
    assert.ok(pdfCount > 0 && pdfCount <= 415, 'PDF filter must return non-zero subset of courses');

    const audioTree = buildTreeData(courses, 'audio', '');
    const audioCount = audioTree.reduce((acc, node) => acc + (node.count || 0), 0);
    assert.ok(audioCount > 0, 'Audio filter must return courses');
  });

  await t.test('search query matches by name, category, and metadata', () => {
    const yogaTree = buildTreeData(courses, 'all', '瑜伽師地論');
    const yogaCount = yogaTree.reduce((acc, node) => acc + (node.count || 0), 0);
    assert.ok(yogaCount >= 10, `瑜伽師地論 query should return at least 10 courses, got ${yogaCount}`);

    const diamondTree = buildTreeData(courses, 'all', '金剛經');
    const diamondCount = diamondTree.reduce((acc, node) => acc + (node.count || 0), 0);
    assert.ok(diamondCount >= 1, '金剛經 query should find courses');

    const emptyTree = buildTreeData(courses, 'all', 'non_existent_buddha_sutra_query_xyz');
    assert.strictEqual(emptyTree.length, 0, 'Invalid search query must return empty tree');
  });
});
