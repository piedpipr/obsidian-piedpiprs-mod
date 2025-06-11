const { Plugin, Notice, MarkdownView, Setting, PluginSettingTab, Modal } = require('obsidian');

// Confirmation Modal for Phantom Notes
class PhantomNoteConfirmModal extends Modal {
    constructor(app, fileName, onConfirm, onCancel) {
        super(app);
        this.fileName = fileName;
        this.onConfirm = onConfirm;
        this.onCancel = onCancel;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        
        contentEl.createEl('h2', { text: 'Create New Note?' });
        contentEl.createEl('p', { 
            text: `Do you want to create the note "${this.fileName}"?` 
        });
        
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        buttonContainer.style.cssText = 'display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;';
        
        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.onclick = () => {
            this.close();
            this.onCancel?.();
        };
        
        const createBtn = buttonContainer.createEl('button', { 
            text: 'Create Note',
            cls: 'mod-cta'
        });
        createBtn.onclick = () => {
            this.close();
            this.onConfirm?.();
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Settings Tab
class PiedpiprModSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Piedpipr\'s Mod Settings' });

        new Setting(containerEl)
            .setName('Block Reference Alias')
            .setDesc('Automatically add dashes and aliases to block references when you press space after ]]')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.blockReferenceAlias)
                .onChange(async (value) => {
                    this.plugin.settings.blockReferenceAlias = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateFeatureStates();
                }));

        new Setting(containerEl)
            .setName('Phantom Note Confirmation')
            .setDesc('Show confirmation dialog before creating new notes from phantom links')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.phantomNoteConfirmation)
                .onChange(async (value) => {
                    this.plugin.settings.phantomNoteConfirmation = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateFeatureStates();
                }));

        new Setting(containerEl)
            .setName('Auto Hide Properties')
            .setDesc('Automatically hide/fold properties section when opening notes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoHideProperties)
                .onChange(async (value) => {
                    this.plugin.settings.autoHideProperties = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateFeatureStates();
                }));
    }
}

// Main Plugin Class
class PiedpirsModPlugin extends Plugin {
    constructor(app, manifest) {
        super(app, manifest);
        this.originalCreateNewFile = null;
        this.editorChangeHandler = null;
        this.activeLeafChangeHandler = null;
        this.currentEditor = null;
        this.lastProcessedContent = '';
        this.processedFiles = new Set();
    }

    async onload() {
        try {
            await this.loadSettings();
            this.addSettingTab(new PiedpiprModSettingTab(this.app, this));
            
            this.addRibbonIcon('settings', 'Piedpipr\'s Mod', () => {
                new Notice('Piedpipr\'s Mod is running!');
            });

            this.addCommand({
                id: 'process-block-reference',
                name: 'Process Block References (Manual)',
                editorCallback: (editor) => {
                    if (this.settings.blockReferenceAlias) {
                        this.processEntireDocument(editor);
                    } else {
                        new Notice('Block Reference Alias feature is disabled');
                    }
                }
            });

            this.updateFeatureStates();
            new Notice('Piedpipr\'s Mod loaded!');
            
        } catch (error) {
            console.error('Error loading Piedpipr\'s Mod:', error);
            new Notice('Error loading Piedpipr\'s Mod');
        }
    }

    async loadSettings() {
        const defaultSettings = {
            blockReferenceAlias: true,
            phantomNoteConfirmation: true,
            autoHideProperties: false
        };
        
        const loadedData = await this.loadData();
        this.settings = Object.assign({}, defaultSettings, loadedData);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    updateFeatureStates() {
        this.updateBlockReferenceFeature();
        this.updatePhantomNoteFeature();
        this.updateAutoHidePropertiesFeature();
    }

    updateBlockReferenceFeature() {
        // Clean up existing handler
        if (this.editorChangeHandler) {
            this.app.workspace.off('editor-change', this.editorChangeHandler);
            this.editorChangeHandler = null;
        }

        if (this.settings.blockReferenceAlias) {
            // Use editor-change event instead of global keydown - much more efficient
            this.editorChangeHandler = this.createEditorChangeHandler();
            this.app.workspace.on('editor-change', this.editorChangeHandler);
        }
    }

    createEditorChangeHandler() {
        return (editor, info) => {
            // Only process if the change was typing (not programmatic)
            if (!info.from || !info.to || info.text.length !== 1 || info.text[0] !== ' ') {
                return;
            }

            // Quick check: only process if the line contains ]]
            const cursor = editor.getCursor();
            const line = editor.getLine(cursor.line);
            
            // Fast indexOf check before regex
            if (line.indexOf(']]') === -1) return;
            
            // Check if we just typed space after ]]
            const beforeSpace = line.substring(0, cursor.ch - 1);
            if (beforeSpace.endsWith(']]')) {
                // Process immediately - no timeout needed since this only fires on actual changes
                this.processCurrentLine(editor, cursor.line, line);
            }
        };
    }

    updatePhantomNoteFeature() {
        // Restore original function
        if (this.originalCreateNewFile) {
            this.app.vault.create = this.originalCreateNewFile;
            this.originalCreateNewFile = null;
        }

        if (this.settings.phantomNoteConfirmation) {
            this.originalCreateNewFile = this.app.vault.create.bind(this.app.vault);
            this.app.vault.create = this.interceptCreateNewFile.bind(this);
        }
    }

    updateAutoHidePropertiesFeature() {
        // Clean up existing handler
        if (this.activeLeafChangeHandler) {
            this.app.workspace.off('active-leaf-change', this.activeLeafChangeHandler);
            this.activeLeafChangeHandler = null;
        }

        // Clear processed files when feature is toggled
        this.processedFiles.clear();

        if (this.settings.autoHideProperties) {
            this.activeLeafChangeHandler = this.createLeafChangeHandler();
            this.app.workspace.on('active-leaf-change', this.activeLeafChangeHandler);
        }
    }

    createLeafChangeHandler() {
        return (leaf) => {
            // Only process markdown views
            if (!leaf?.view || !(leaf.view instanceof MarkdownView)) return;
            
            const file = leaf.view.file;
            if (!file) return;
            
            // Avoid processing the same file multiple times in a session
            const fileKey = file.path;
            if (this.processedFiles.has(fileKey)) return;
            
            // Mark as processed immediately to prevent duplicate calls
            this.processedFiles.add(fileKey);
            
            // Use a minimal delay and check if properties exist before folding
            setTimeout(() => {
                try {
                    // Check if the view is still active and has properties to fold
                    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (activeView && activeView.file?.path === fileKey) {
                        // Only execute if there are properties to fold
                        const content = activeView.editor.getValue();
                        if (content.startsWith('---\n') && content.indexOf('\n---\n') > 0) {
                            this.app.commands.executeCommandById('editor:toggle-fold-properties');
                        }
                    }
                } catch (error) {
                    // Silently fail - command might not be available
                }
            }, 100);
        };
    }

    async interceptCreateNewFile(path, data) {
        if (path.endsWith('.md') && !await this.app.vault.adapter.exists(path)) {
            return new Promise((resolve, reject) => {
                const fileName = path.replace(/\.md$/, '');
                const modal = new PhantomNoteConfirmModal(
                    this.app,
                    fileName,
                    async () => {
                        try {
                            const result = await this.originalCreateNewFile(path, data);
                            new Notice(`✅ Created note: ${fileName}`);
                            resolve(result);
                        } catch (error) {
                            reject(error);
                        }
                    },
                    () => {
                        new Notice('Note creation cancelled');
                        reject(new Error('Note creation cancelled by user'));
                    }
                );
                modal.open();
            });
        }
        return this.originalCreateNewFile(path, data);
    }

    processCurrentLine(editor, lineNum, lineContent) {
        try {
            // Fast check using indexOf before regex
            if (lineContent.indexOf('#‣') === -1) return;
            
            // Single pass regex with efficient replacement
            const newLine = lineContent.replace(/\[\[([^|\]]+?#‣[^|\]]+?)\]\]/g, (match, linkContent) => {
                // Extract block ID efficiently
                const lastHash = linkContent.lastIndexOf('#‣');
                if (lastHash === -1) return match;
                
                const afterHash = linkContent.substring(lastHash + 2);
                const blockIdMatch = afterHash.match(/([A-Z0-9]{4,})$/);
                
                if (blockIdMatch) {
                    const blockId = blockIdMatch[1];
                    return ` - [[${linkContent}|${blockId}]]`;
                }
                return match;
            });
            
            // Only update if changed
            if (newLine !== lineContent) {
                editor.setLine(lineNum, newLine);
                new Notice(`✅ Added dash and alias to block reference`);
            }
        } catch (error) {
            console.error('Error processing line:', error);
        }
    }

    processEntireDocument(editor) {
        try {
            const fullContent = editor.getValue();
            
            if (!fullContent.trim()) {
                new Notice('ℹ️ Document is empty');
                return;
            }
            
            // Fast check before regex
            if (fullContent.indexOf('#‣') === -1) {
                new Notice('ℹ️ No block reference wikilinks found');
                return;
            }
            
            let replacementCount = 0;
            
            // Single pass replacement
            const processedContent = fullContent.replace(/\[\[([^|\]]+?#‣[^|\]]+?)\]\]/g, (match, linkContent) => {
                // Extract block ID efficiently
                const lastHash = linkContent.lastIndexOf('#‣');
                if (lastHash === -1) return match;
                
                const afterHash = linkContent.substring(lastHash + 2);
                const blockIdMatch = afterHash.match(/([A-Z0-9]{4,})$/);
                
                if (blockIdMatch) {
                    const blockId = blockIdMatch[1];
                    replacementCount++;
                    return ` - [[${linkContent}|${blockId}]]`;
                }
                return match;
            });
            
            if (replacementCount > 0) {
                editor.setValue(processedContent);
                new Notice(`✅ Added dashes and aliases to ${replacementCount} block reference${replacementCount === 1 ? '' : 's'}`);
            } else {
                new Notice('ℹ️ No block references needed aliases');
            }
        } catch (error) {
            console.error('Error:', error);
            new Notice(`❌ Error: ${error.message}`);
        }
    }

    onunload() {
        try {
            // Clean up event listeners
            if (this.editorChangeHandler) {
                this.app.workspace.off('editor-change', this.editorChangeHandler);
                this.editorChangeHandler = null;
            }
            
            if (this.activeLeafChangeHandler) {
                this.app.workspace.off('active-leaf-change', this.activeLeafChangeHandler);
                this.activeLeafChangeHandler = null;
            }
            
            // Restore original functions
            if (this.originalCreateNewFile) {
                this.app.vault.create = this.originalCreateNewFile;
                this.originalCreateNewFile = null;
            }
            
            // Clear caches
            this.processedFiles.clear();
            
        } catch (error) {
            console.error('Error unloading Piedpipr\'s Mod:', error);
        }
    }
}

module.exports = PiedpirsModPlugin;