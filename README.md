# Remember File State

This [Obsidian](https://obsidian.md) plugin remembers the editor state of files
as you switch between them. It restores the cursor position and scrolling position.
The plugin doesn't do any polling, and strives to only do work when
opening and closing files in order to not slow down the editing experience.

Note that this plugin doesn't currently remember state across sessions.


## Developer Quickstart

My own workflow for working on this plugin is the following:

1. Install the "_Remember File State_" plugin in a test vault. Don't forget to
   enable it.
2. Clone the `obsidian-remember-file-state` repository.
3. Run the usual incantations, such as `npm install`.
4. Run the build process in watch mode so that it compiles the TypeScript code
   and overwrites the test vault's plugin: `npm run dogfood
   /path/to/vault/.obsidian/plugins/obsidian-remember-state`.
5. When making changes, trigger the "_Reload App Without Saving_" command to
   reload Obsidian.
6. Optionally, hit `Ctrl-Shift-I` to open the developer console and see the
   console log.

