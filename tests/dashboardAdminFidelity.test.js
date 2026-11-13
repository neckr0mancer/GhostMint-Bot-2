const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'dashboard', 'src', 'Admin.jsx'), 'utf8');
const app = fs.readFileSync(path.join(root, 'dashboard', 'src', 'App.jsx'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'dashboard', 'src', 'shared.jsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'dashboard', 'src', 'styles.css'), 'utf8');
const api = fs.readFileSync(path.join(root, 'src', 'dashboard', 'api.js'), 'utf8');

test('admin audit is pageable, filterable, and retryable instead of a fixed latest-200 snapshot', () => {
  assert.doesNotMatch(admin, /security-audit\?limit=200/);
  assert.match(admin, /security-audit\?page=\$\{page\}&pageSize=\$\{pageSize\}/);
  assert.match(admin, /Search audit log/);
  assert.match(admin, /Audit evidence could not be loaded/);
  assert.match(admin, /<Pager value=\{payload\} page=\{payload\.page\} setPage=\{setPage\}\/>/);
});

test('restore-account controls obtain an explicit confirmation before calling the protected API', () => {
  const restore = admin.slice(admin.indexOf('function RestoreAccountControl'), admin.indexOf('function AccountFlagsControl'));
  assert.match(restore, /<ConfirmAction/);
  assert.match(restore, /confirmation:'CONFIRM'/);
  assert.doesNotMatch(restore, /<form/);
});

test('root-owner changes are accepted by the structured adapter and require confirmation', () => {
  assert.match(api, /'root-owner':\['platform','platformUserId','enabled'\]/);
  assert.match(api, /'group-delete','owner','root-owner','ban'/);
});

test('effective lookup rejects stale responses and Admin health renders every readiness dependency', () => {
  assert.match(admin, /effectiveRequestId=useRef\(0\)/);
  assert.match(admin, /requestId===effectiveRequestId\.current/);
  assert.match(admin, /Scheduled preflight worker/);
  assert.match(admin, /Wallet history worker/);
});

test('overview-backed Admin forms remain skeletons until current data arrives', () => {
  assert.match(admin, /\['Groups','Users','Presets'\]\.includes\(section\)&&overview\.data===null/);
  assert.match(admin, /Loading current administration data and controls/);
});

test('Admin writes lock only their consequential form and restore every previous disabled state', () => {
  assert.match(admin, /function lockForm\(form\)/);
  assert.match(admin, /previous=controls\.map\(control=>\(\{control,disabled:control\.disabled\}\)\)/);
  assert.match(admin, /finally\{unlock\(\);\}/);
  assert.match(admin, /<Form[^>]+busy=\{busy\}/);
  assert.match(admin, /\{busy\?'Importing…':'Import batch'\}/);
});

test('wallet batch import defaults to per-wallet chain detection and only sends a manual override', () => {
  const batch = admin.slice(admin.indexOf('function BatchImport'), admin.indexOf('function AdminLoadFailure'));
  assert.match(batch, /useState\(''\)/);
  assert.match(batch, /Auto-detect each wallet/);
  assert.match(batch, /chain:values\.chain\|\|undefined/);
  assert.doesNotMatch(batch, /select name="chain" required/);
});

test('group retention is populated from saved values and visible on each group card', () => {
  assert.match(admin, /function RetentionPolicyForm/);
  assert.match(admin, /defaultValue=\{selected\?\.retentionPeriodDays\?\?'off'\}/);
  assert.match(admin, /defaultValue=\{selected\?\.requireRecentActivityDays\?\?'off'\}/);
  assert.match(admin, /<dt>Retention period<\/dt>/);
  assert.match(admin, /<dt>Active subscription<\/dt>/);
  assert.match(admin, /<dt>Recent activity<\/dt>/);
});

test('overview drilldowns use the exact server-owned activity classifications', () => {
  assert.match(admin, /active:user=>user\.dashboardActive===true/);
  assert.match(admin, /active24h:user=>user\.activeAnyPlatform24h===true/);
});

test('a failed background refresh keeps last-known Admin data and forms mounted', () => {
  assert.match(admin, /overviewFailed&&overview\.data===null/);
  assert.match(admin, /overviewFailed&&overview\.data!==null/);
  assert.match(admin, /The last successful data remains visible/);
  assert.match(admin, /if\(error&&!data\)return/);
});

test('Admin overlays trap and restore focus while closed sheets leave no hidden controls tabbable', () => {
  assert.match(shared, /export function useModalAccessibility/);
  assert.match(shared, /document\.body\.style\.overflow='hidden'/);
  assert.match(shared, /previouslyFocused\.focus/);
  assert.match(admin, /useModalAccessibility\(Boolean\(user\),dialogRef/);
  assert.match(app, /useModalAccessibility\(open,layerRef/);
  assert.match(app, /if\(!open\)return null/);
  assert.match(app, /aria-controls="admin-more-sheet"/);
});

test('dashboard and Admin More sheets keep their scrims inside the active modal branch', () => {
  const dashboardSheet = app.slice(app.indexOf('function MoreSheet('), app.indexOf('function automationBadges('));
  const adminSheet = app.slice(app.indexOf('function AdminMoreSheet('), app.indexOf('function ScrollTop('));
  for (const source of [dashboardSheet, adminSheet]) {
    assert.match(source, /const layerRef=useRef\(null\)/);
    assert.match(source, /useModalAccessibility\(open,layerRef/);
    assert.match(source, /<div ref=\{layerRef\} className="sheet-layer"[^>]*><div className="sheet-backdrop" onClick=\{onClose\}/);
  }
  assert.match(styles, /\.sheet-layer\{display:contents\}/);
});

test('the user dashboard Admin entry crosses to the separate Admin mount instead of an undefined page slug', () => {
  const navigation = app.slice(app.indexOf('function go(item'), app.indexOf('function renderCurrentPage'));
  assert.match(navigation, /if\(item==='Admin'\)\{window\.location\.href='\/dashboard\/admin';return;\}/);
});

test('Admin uses the labelled prototype rail and a real Overview glyph', () => {
  const sections = app.slice(app.indexOf('const ADMIN_SECTIONS='), app.indexOf('const ADMIN_SLUGS='));
  const shell = app.slice(app.indexOf('function AdminShell('), app.indexOf('function isAdminPath('));
  assert.doesNotMatch(sections, /NAV_ICONS\.Dashboard/);
  assert.match(app, /const ADMIN_OVERVIEW_ICON=<svg \{\.\.\.RAIL_ICON_PROPS\}/);
  assert.match(app, /const ADMIN_DASHBOARD_ICON=RAIL_ICONS\.Home/);
  assert.match(sections, /id:'Overview'.*icon:ADMIN_OVERVIEW_ICON/);
  assert.match(app, /const ADMIN_GROUPS=\['Manage','Policy','Access','System'\]/);
  assert.match(app, /className=\{`admin-rail-group-toggle/);
  assert.match(app, /aria-expanded=\{expanded\} aria-controls=\{panelId\}/);
  assert.match(app, /className="admin-rail-group-items" hidden=\{!expanded\}/);
  assert.match(shell, /className="rail admin-rail"/);
  assert.match(shell, /className="railfoot"/);
  assert.doesNotMatch(shell, /rail-edge-toggle|data-rail=/);
});

test('Admin rail groups collapse independently while the active group opens on navigation', () => {
  const navigation = app.slice(app.indexOf('function AdminNav('), app.indexOf('function AdminBottomBar('));
  assert.match(navigation, /useState\(\(\)=>new Set\(\[activeGroup\]\)\)/);
  assert.match(navigation, /current\.has\(activeGroup\)\?current:new Set\(\[\.\.\.current,activeGroup\]\)/);
  assert.match(navigation, /function toggleGroup\(group\)/);
  assert.match(navigation, /if\(next\.has\(group\)\)next\.delete\(group\);else next\.add\(group\)/);
});

test('Admin keeps footer actions fixed and hides the middle rail scrollbar', () => {
  assert.match(styles, /\.admin-rail\{overflow:hidden\}/);
  assert.match(styles, /\.admin-rail-sections\{[^}]*flex:1;min-height:0;overflow-y:auto;[^}]*scrollbar-width:none/);
  assert.match(styles, /\.admin-rail-sections::\-webkit-scrollbar\{display:none\}/);
  assert.match(styles, /\.admin-rail \.railfoot\{flex:none;background:var\(--surface\)\}/);
});

test('Admin dashboard and logout actions use distinct semantic icons on desktop and mobile', () => {
  const shell = app.slice(app.indexOf('function AdminShell('), app.indexOf('function isAdminPath('));
  const sheet = app.slice(app.indexOf('function AdminMoreSheet('), app.indexOf('function ScrollTop('));
  assert.match(app, /const ADMIN_LOGOUT_ICON=<svg[^;]*M10 4H5[^;]*m15 8 4 4-4 4M19 12H9/);
  assert.match(shell, /href="\/dashboard\/">\{ADMIN_DASHBOARD_ICON\}<span className="nav-l">User dashboard<\/span>/);
  assert.match(shell, /className="nav admin-logout-action"[^>]*>\{ADMIN_LOGOUT_ICON\}<span className="nav-l">Log out<\/span>/);
  assert.match(sheet, /\{ADMIN_DASHBOARD_ICON\}<\/span><span>Dashboard<\/span>/);
  assert.match(sheet, /className="b d"[^>]*>[^<]*<span className="admin-action-icon"[^>]*>\{ADMIN_LOGOUT_ICON\}/);
  assert.match(styles, /\.admin-sheet-actions\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.admin-rail \.admin-logout-action\{background:var\(--loss\);color:#fff\}/);
});

test('Admin mobile navigation fills all five slots before More', () => {
  assert.match(app, /const ADMIN_MOBILE_PRIMARY=\['Overview','Groups','Users','Presets'\]/);
  assert.match(app, /ADMIN_MOBILE_MORE=ADMIN_SECTIONS\.map\(section=>section\.id\)\.filter/);
  assert.match(styles, /\.mobile-bottombar\.admin-mobile-bottombar\{\s*grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(styles, /\.mobile-bottombar\.admin-mobile-bottombar\{\s*grid-template-columns:repeat\(4/);
});

test('User cards expose a separate details button instead of nesting controls in a button-like card', () => {
  const users = admin.slice(admin.indexOf('function Users('), admin.indexOf('function Presets('));
  assert.doesNotMatch(users, /role="button" tabIndex="0"/);
  assert.match(users, />View details<\/button>/);
  assert.match(users, /event\.target\.closest\('button,a,input,select,textarea,summary'\)/);
});

test('Admin compact form rows stay paired where useful without crowding long or sensitive content', () => {
  assert.match(admin, /function AdminCompactRow\(\{children,variant='equal'\}\)/);
  assert.match(admin, /<AdminCompactRow variant="identity">/,
    'platform and platform-user-ID controls need the asymmetric compact-row modifier');
  assert.match(admin, /<AdminCompactRow variant="actions">/,
    'paired actions need the full-cell action modifier');
  assert.match(styles, /\.admin-compact-row\{display:contents\}/,
    'wide layouts must keep compact wrappers transparent to the existing form grid');
  assert.match(styles, /\.admin-compact-row>\*\{min-width:0\}/);
  assert.match(styles, /\.admin-view \.fields>:is\([^}]*\.warning-box[^}]*\.notice[^}]*\.account-merge-preview[^}]*\)\{\s*grid-column:1\/-1;min-width:0\}/,
    'previews, errors, confirmations, and merge evidence must remain full width');
  assert.match(styles, /\.admin-view \.fields>fieldset>:is\([^}]*\.warning-box[^}]*\.notice[^}]*\.account-merge-preview[^}]*\)/,
    'the full-width guard must also reach fields nested inside the shared Form fieldset');

  assert.match(styles, /@media\(max-width:1050px\)\{\s*\.admin-overview-grid,\.admin-control-grid,\.admin-effective-layout,\.admin-owner-layout,\s*\.admin-preset-grid\{grid-template-columns:minmax\(0,1fr\)\}\s*\.admin-view \.form \.fields\{grid-template-columns:minmax\(0,1fr\)\}/,
    'tablet Admin layouts must stack outer panels before the fixed rail crowds their forms');
  assert.match(styles, /@media\(min-width:360px\) and \(max-width:1050px\)\{[\s\S]*?\.admin-compact-row\{display:grid;grid-column:1\/-1;\s*grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:\.625rem;align-items:stretch/,
    'explicit compact pairs must remain two-up from phone through tablet widths');
  assert.match(styles, /\.admin-compact-row--identity\{grid-template-columns:minmax\(6\.75rem,\.7fr\) minmax\(0,1\.3fr\)\}/);
  assert.match(styles, /\.admin-compact-row--actions>button\{width:100%;max-width:100%;min-width:0;min-height:44px;\s*align-self:stretch;justify-self:stretch\}/);
  assert.match(styles, /\.admin-compact-row :is\(label,input,select,textarea,button\)\{min-width:0;max-width:100%\}/,
    'paired controls must be allowed to shrink without creating horizontal page overflow');
  assert.doesNotMatch(styles, /@media\(max-width:359px\)[\s\S]*?\.admin-compact-row\{[^}]*display:grid/,
    'below 360px the display:contents base must expose fields to the one-column parent grid');
});

test('Admin Overview keeps short mobile facts compact without applying the rule to forms', () => {
  const mobile = styles.slice(styles.indexOf('@media(max-width:700px)'), styles.indexOf('@media(min-width:701px)'));
  assert.match(mobile, /\.admin-metric-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:\.5rem\}/,
    'the six overview metrics should render as three two-up rows on phones');
  assert.match(mobile, /\.admin-metric-grid>\.panel:last-child:nth-child\(odd\)\{grid-column:1\/-1\}/,
    'only an unmatched final metric may span, so Owners stays beside Seat groups when all six exist');
  assert.match(mobile, /\.admin-metric-grid p\{display:none\}/,
    'redundant desktop descriptions should not inflate mobile metric links');
  assert.match(mobile, /\.admin-distribution\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:\.5rem\}/,
    'short access facts should share mobile rows');
  assert.match(mobile, /\.admin-distribution>div:last-child:nth-child\(odd\)\{grid-column:1\/-1\}/,
    'the unmatched third access fact should use the remaining row cleanly');
  assert.doesNotMatch(mobile, /\.admin-view \.form \.fields\{grid-template-columns:repeat\(2/,
    'the summary-density rule must not force arbitrary Admin forms into two columns');
  assert.match(mobile, /\.session-policy\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/,
    'short Account session facts should follow the same two-up mobile information rule');
});
