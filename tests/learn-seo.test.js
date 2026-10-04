// The Learn course facts written into static pages for search engines and
// AI assistants (synth.html's /learn structured data, the /free-sql-course
// syllabus) must match learn-curriculum.js. Adding or retiming a lesson
// fails here until those pages are updated.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../learn-curriculum.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const minutes = (level) => level.lessons.reduce((a, l) => a + l.minutes, 0);
const iso = (m) => `PT${Math.floor(m / 60)}H${m % 60}M`;

test('/learn structured data in synth.html matches the curriculum', () => {
  const html = read('synth.html');
  for (const level of C.LEVELS) {
    const row = `['${level.id}', '${level.title}', '${level.level}', ${level.lessons.length}, '${iso(minutes(level))}'`;
    assert.ok(html.includes(row), `synth.html is missing ${row}`);
  }
});

test('the /free-sql-course syllabus lists every lesson with its course data', () => {
  const html = read('free-sql-course.html');
  for (const lesson of C.LESSONS) {
    assert.ok(html.includes(`href="/learn?lesson=${lesson.id}"`), `syllabus is missing lesson ${lesson.id}`);
  }
  const ld = JSON.parse(html.split('<script type="application/ld+json">')[1].split('</script>')[0]);
  const courses = ld['@graph'].find((n) => n['@type'] === 'ItemList').itemListElement.map((i) => i.item);
  assert.deepEqual(
    courses.map((c) => [c.numberOfLessons, c.timeRequired]),
    C.LEVELS.map((l) => [l.lessons.length, iso(minutes(l))])
  );
});
