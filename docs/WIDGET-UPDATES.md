# Updating installed widgets

An installed widget can be updated from a local widget ZIP without deleting its
tile or replacing its OBS browser-source URL. This updates the widget package;
it does not check a remote server or automatically download widget releases.

## Install an update

1. Open the existing widget and click **Update** in its header.
2. Click **Choose ZIP** and select the new widget package.
3. Leave **Update all matching widgets** unchecked to update this layout only,
   or select it to update every installed layout with the same `config/meta.json`
   `id`. Each layout keeps its own settings.
4. Review the current and target versions, added/removed/renamed settings, and
   any notices. Click **Update widget** or **Update N widgets**.

Connected browser sources reload after the update. If a source was disconnected,
reload it in OBS. Selecting a ZIP with the same version is supported and shown as
a reinstall. If files or settings changed after the preview, select the ZIP again
to review the current state before updating.

The update preserves the tile identity, name, placement, browser-source URL,
compatible account selections, media references, and shared storage namespace.
Existing settings retain their saved values, including `false`, `0`, and empty
strings. Untouched settings retain the old defaults; genuinely new settings use
the new package's defaults. Repeating settings retain row IDs, names, order, and
values. Required core media missing from the new ZIP is copied from the old core;
shared media-gallery files are retained.

Removed settings disappear from the form, and their known saved values and media
volume companions are retired. Other values stored by widget scripts are kept;
the preview reports those preserved values. An incompatible type, selected
option, or numeric bound stops the update instead of silently resetting a value.
The widget author must supply an explicit migration for that change.

## Restore the previous version

Open **Update** on the affected layout, click **Restore previous version**, and
confirm **Restore**. This restores that layout's code, settings, and valid account
selections from immediately before its last update. Settings and account-selection
changes made after that update are replaced. The tile and OBS URL stay the same;
other layouts and account credentials are unaffected.

One pre-update backup is kept per layout. A later successful update replaces it;
a successful restore consumes it. Shared widget storage and the media gallery
are not rolled back, so a widget's own shared-data migrations must remain
compatible with the earlier code if rollback support is needed.

## Package requirements

Use the ordinary widget ZIP layout, with `config/meta.json`,
`config/settings.json`, and entry points such as `index.html` at the ZIP root.
The installed package and ZIP must have the same nonempty metadata `id` and the
same `storageNamespace`, including whether a namespace is declared. Use a stable
package ID across releases. An update can add or remove files and functionality
inside `core/`; edits made directly to the old core are replaced.

Account slots are matched by stable optional `id`, or by an unambiguous
`service`/`type` pair for older packages. Assignments to removed slots are removed.
Changing the order of duplicate legacy slots is rejected because their identity
cannot be inferred. Their slot list must remain unchanged, including adding IDs;
reordering is supported when stable IDs were already present in the installed
package. An existing slot ID cannot change its platform or account type.

The app validates paths, duplicate entries, metadata, entry points, settings, and
archive size limits before installation. ZIP extraction and each layout's next
core, values, and backup are staged first. Native code then replaces the core,
values, account-slot assignments, and backup as a coordinated operation. A
recovery journal is persisted before each rename. Failed batches are rolled back,
including layouts already changed; startup recovery also rolls back unfinished
swaps after an interrupted process. This does not guarantee atomic recovery from
hardware failure or power loss. If rollback itself fails, the app retains recovery
files and asks you to restart Slime2; keep those files until recovery succeeds.

## Authoring settings migrations

Compatible additions and removals need no migration file. For renamed fields or
changed value formats, include optional `config/migrations.json`:

```json
{
  "schemaVersion": 1,
  "migrations": [
    {
      "from": "1.0.0",
      "to": "1.1.0",
      "operations": [
        { "type": "rename", "from": "fontSizeText", "to": "fontSize" },
        { "type": "convert", "key": "fontSize", "conversion": "to-number" },
        {
          "type": "convert",
          "key": "rules[].mode",
          "conversion": "map",
          "mappings": [{ "from": "legacy", "to": "standard" }]
        }
      ]
    },
    {
      "from": "1.1.0",
      "to": "1.2.0",
      "operations": []
    }
  ]
}
```

Version strings match exactly. When a manifest is present, it must provide one
complete chain from each supported installed version to the target version;
include empty steps for compatible releases. Branches sharing a `from` version,
cycles, unknown properties, and malformed operations are rejected. Reinstalling
the same version applies no migration operations, while still validating the
manifest and reconciling the settings.

Operations run in order, against the old settings and any preceding renames:

| Operation | Behavior |
| --- | --- |
| `rename` | Moves a field and its media-volume companions. The destination must not already contain a setting or saved value. |
| `to-string` | Converts a finite number, boolean, or string into a string. |
| `to-number` | Accepts a finite number or a decimal numeric string, including decimal exponents. Empty strings, hexadecimal, and infinity are rejected. |
| `to-boolean` | Accepts booleans, strings `"true"`/`"false"`, or numbers `1`/`0`. |
| `map` | Replaces exact scalar values using `mappings`; for arrays, maps each element. Unmatched values are retained and then validated. |

Category and ordinary section IDs do not prefix field IDs. A repeated child uses
`groupId[].fieldId`; its operation applies to every existing row. Renaming a
repeated group, then its children, preserves the original row IDs and names.
Children cannot be moved between different repeated groups. Group-to-input and
input-to-group conversions are unsupported. Operations cannot create arbitrary
state or act on unknown script-owned fields, and must work for the oldest
installed schema supported by their version chain. Scalar conversions do not
accept arrays or null; `map` accepts null scalars, but cannot create null array
entries. Every resulting value must satisfy the destination setting.

Keep regular field keys unique across categories and ordinary sections. Media
fields reserve their `.volume` companion keys; `[]` is reserved for migration
paths. Migration files are declarative JSON only, with limits of 128 version
steps, 1,024 total operations, and 1,024 mappings per operation. They cannot run
JavaScript or migrate the separate shared-storage database.
