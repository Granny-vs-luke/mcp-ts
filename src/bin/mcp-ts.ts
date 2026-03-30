#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';

/**
 * MCP-TS CLI Utility
 * 
 * Provides helper commands for users of the @mcp-ts/sdk library.
 */
async function run() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (command === 'supabase-init') {
        await initSupabase();
    } else {
        showHelp();
    }
}

function showHelp() {
    console.log(`
🚀 MCP-TS CLI Utility
Usage: npx mcp-ts <command>

Commands:
  supabase-init    Initialize Supabase migrations in your project
    `);
}

async function initSupabase() {
    console.log('🚀 Initializing Supabase storage for MCP-TS...');

    // When running from dist/bin/mcp-ts.js (compiled), __dirname is dist/bin.
    // The supabase/ migrations are at the root of the package.
    // We need to look up two levels to find 'supabase' folder in the package.
    const pkgRoot = path.resolve(__dirname, '../..');
    const sourceDir = path.join(pkgRoot, 'supabase', 'migrations');
    
    if (!fs.existsSync(sourceDir)) {
        console.error(`❌ Error: Could not find migration files in package at: ${sourceDir}`);
        console.log('Please ensure you are running this from a project where @mcp-ts/sdk is installed.');
        process.exit(1);
    }

    const targetDir = path.join(process.cwd(), 'supabase', 'migrations');

    try {
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
            console.log(`📁 Created directory: ${targetDir}`);
        }

        const files = fs.readdirSync(sourceDir);
        let copiedCount = 0;

        for (const file of files) {
            if (file.endsWith('.sql')) {
                const srcPath = path.join(sourceDir, file);
                const destPath = path.join(targetDir, file);
                
                if (fs.existsSync(destPath)) {
                    console.log(`⏭️  Skipping existing migration: ${file}`);
                    continue;
                }

                fs.copyFileSync(srcPath, destPath);
                console.log(`✅ Copied: ${file}`);
                copiedCount++;
            }
        }

        if (copiedCount > 0) {
            console.log('\n✨ Database migrations successfully initialized!');
            console.log('\nNext steps:');
            console.log('1. Link your Supabase project:');
            console.log('   npx supabase link --project-ref <your-project-id>');
            console.log('\n2. Push the migrations to your remote database:');
            console.log('   npx supabase db push');
        } else if (files.length > 0) {
            console.log('\n👍 All migration files are already present in your project.');
        } else {
            console.log('⚠️  No migration files found to copy.');
        }

    } catch (error: any) {
        console.error(`❌ Error initializing Supabase: ${error.message}`);
        process.exit(1);
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
