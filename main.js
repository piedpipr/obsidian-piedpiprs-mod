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
            .setName('Confirm All New Notes')
            .setDesc('Show confirmation dialog before creating ANY new notes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.confirmAllNewNotes)
                .onChange(async (value) => {
                    this.plugin.settings.confirmAllNewNotes = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateFeatureStates();
                }));

        new Setting(containerEl)
            .setName('Confirm Phantom Notes Only')
            .setDesc('Show confirmation dialog only for phantom notes (notes created from non-existing links)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.confirmPhantomNotesOnly)
                .onChange(async (value) => {
                    this.plugin.settings.confirmPhantomNotesOnly = value;
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
        this.keydownHandler = null;
        this.activeLeafChangeHandler = null;
        this.processedFiles = new Set();
        this.isCreatingFromPhantomLink = false;
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

            // Hook into link click events to detect phantom link creation
            this.registerDomEvent(document, 'click', this.handleLinkClick.bind(this));

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
            confirmAllNewNotes: false,
            confirmPhantomNotesOnly: true,
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
        if (this.keydownHandler) {
            document.removeEventListener('keydown', this.keydownHandler);
            this.keydownHandler = null;
        }

        if (this.settings.blockReferenceAlias) {
            this.keydownHandler = this.createKeydownHandler();
            document.addEventListener('keydown', this.keydownHandler);
        }
    }

    createKeydownHandler() {
        return (event) => {
            // Only process space key
            if (event.code !== 'Space') return;
            
            // Get active editor
            const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!activeView || !activeView.editor) return;
            
            const editor = activeView.editor;
            const cursor = editor.getCursor();
            const line = editor.getLine(cursor.line);
            
            // Quick check: only process if the line contains ]] before cursor
            const beforeCursor = line.substring(0, cursor.ch);
            if (!beforeCursor.endsWith(']]')) return;
            
            // Check if this is a block reference
            if (beforeCursor.indexOf('#‣') === -1) return;
            
            // Prevent default space behavior temporarily
            event.preventDefault();
            
            // Process the line first, then add the space
            setTimeout(() => {
                const updatedLine = editor.getLine(cursor.line);
                const processed = this.processBlockReferenceLine(updatedLine);
                
                if (processed !== updatedLine) {
                    editor.setLine(cursor.line, processed);
                    // Move cursor to end of processed line
                    editor.setCursor({ line: cursor.line, ch: processed.length });
                    new Notice('✅ Added dash and alias to block reference');
                } else {
                    // If no processing was done, just add the space
                    editor.replaceRange(' ', cursor);
                }
            }, 10);
        };
    }

    handleLinkClick(event) {
        // Check if it's a wiki link
        const target = event.target.closest('.internal-link');
        if (!target) return;
        
        const href = target.getAttribute('href');
        if (!href) return;
        
        // Check if the file exists
        const file = this.app.metadataCache.getFirstLinkpathDest(href, '');
        if (!file) {
            // This is a phantom link
            this.isCreatingFromPhantomLink = true;
            // Reset flag after a short delay
            setTimeout(() => {
                this.isCreatingFromPhantomLink = false;
            }, 1000);
        }
    }

    updatePhantomNoteFeature() {
        // Restore original function
        if (this.originalCreateNewFile) {
            this.app.vault.create = this.originalCreateNewFile;
            this.originalCreateNewFile = null;
        }

        if (this.settings.confirmAllNewNotes || this.settings.confirmPhantomNotesOnly) {
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
        if (!path.endsWith('.md')) {
            return this.originalCreateNewFile(path, data);
        }

        const fileExists = await this.app.vault.adapter.exists(path);
        if (fileExists) {
            return this.originalCreateNewFile(path, data);
        }

        // Determine if we should show confirmation
        let shouldConfirm = false;
        
        if (this.settings.confirmAllNewNotes) {
            shouldConfirm = true;
        } else if (this.settings.confirmPhantomNotesOnly && this.isCreatingFromPhantomLink) {
            shouldConfirm = true;
        }

        if (!shouldConfirm) {
            return this.originalCreateNewFile(path, data);
        }

        return new Promise((resolve, reject) => {
            const fileName = path.replace(/\.md$/, '').split('/').pop();
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

    processBlockReferenceLine(lineContent) {
        try {
            // Fast check using indexOf before regex
            if (lineContent.indexOf('#‣') === -1) return lineContent;
            
            // Single pass regex with efficient replacement
            return lineContent.replace(/\[\[([^|\]]+?#‣[^|\]]+?)\]\]/g, (match, linkContent) => {
                // Skip if already has alias
                if (match.includes('|')) return match;
                
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
        } catch (error) {
            console.error('Error processing line:', error);
            return lineContent;
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
            
            // Process line by line for better control
            const lines = fullContent.split('\n');
            const processedLines = lines.map(line => {
                const processed = this.processBlockReferenceLine(line);
                if (processed !== line) {
                    replacementCount++;
                }
                return processed;
            });
            
            if (replacementCount > 0) {
                editor.setValue(processedLines.join('\n'));
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
            if (this.keydownHandler) {
                document.removeEventListener('keydown', this.keydownHandler);
                this.keydownHandler = null;
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