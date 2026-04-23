import { memo, useEffect, useState } from 'react';
import { bundledLanguages, codeToHtml, isSpecialLang, type BundledLanguage, type SpecialLanguage } from 'shiki';
import { classNames } from '~/utils/classNames';
import { createScopedLogger } from '~/utils/logger';
import { webcontainer } from '~/lib/webcontainer';
import { cleanTerminalOutput } from '~/utils/shell';

import styles from './CodeBlock.module.scss';

const logger = createScopedLogger('CodeBlock');

interface CodeBlockProps {
  className?: string;
  code: string;
  language?: BundledLanguage | SpecialLanguage;
  theme?: 'light-plus' | 'dark-plus';
  disableCopy?: boolean;
}

type RunSpec = {
  filePath: string;
  requiredCommands: string[];
  steps: Array<{ command: string; args: string[] }>;
};

export const CodeBlock = memo(
  ({ className, code, language = 'plaintext', theme = 'dark-plus', disableCopy = false }: CodeBlockProps) => {
    const [html, setHTML] = useState<string | undefined>(undefined);
    const [copied, setCopied] = useState(false);
    const [running, setRunning] = useState(false);
    const [runOutput, setRunOutput] = useState('');
    const [runExitCode, setRunExitCode] = useState<number | null>(null);

    const copyToClipboard = () => {
      if (copied) {
        return;
      }

      navigator.clipboard.writeText(code);
      setCopied(true);

      setTimeout(() => {
        setCopied(false);
      }, 2000);
    };

    const buildRunSpec = (lang: string): RunSpec | null => {
      const normalized = lang.toLowerCase();
      const runDir = '.bolt-runner';

      if (['python', 'py'].includes(normalized)) {
        return {
          filePath: `${runDir}/run.py`,
          requiredCommands: ['python3'],
          steps: [{ command: 'python3', args: [`${runDir}/run.py`] }],
        };
      }

      if (['javascript', 'js'].includes(normalized)) {
        return {
          filePath: `${runDir}/run.js`,
          requiredCommands: ['node'],
          steps: [{ command: 'node', args: [`${runDir}/run.js`] }],
        };
      }

      if (['typescript', 'ts'].includes(normalized)) {
        return {
          filePath: `${runDir}/run.ts`,
          requiredCommands: ['npx'],
          steps: [{ command: 'npx', args: ['-y', 'tsx', `${runDir}/run.ts`] }],
        };
      }

      if (['bash', 'sh', 'shell'].includes(normalized)) {
        return {
          filePath: `${runDir}/run.sh`,
          requiredCommands: ['bash'],
          steps: [{ command: 'bash', args: [`${runDir}/run.sh`] }],
        };
      }

      if (normalized === 'c') {
        return {
          filePath: `${runDir}/run.c`,
          requiredCommands: ['gcc'],
          steps: [
            { command: 'gcc', args: [`${runDir}/run.c`, '-o', `${runDir}/run_c`] },
            { command: `${runDir}/run_c`, args: [] },
          ],
        };
      }

      if (['cpp', 'c++', 'cc', 'cxx'].includes(normalized)) {
        return {
          filePath: `${runDir}/run.cpp`,
          requiredCommands: ['g++'],
          steps: [
            { command: 'g++', args: [`${runDir}/run.cpp`, '-o', `${runDir}/run_cpp`] },
            { command: `${runDir}/run_cpp`, args: [] },
          ],
        };
      }

      if (normalized === 'java') {
        return {
          filePath: `${runDir}/Main.java`,
          requiredCommands: ['javac', 'java'],
          steps: [
            { command: 'javac', args: [`${runDir}/Main.java`] },
            { command: 'java', args: ['-cp', runDir, 'Main'] },
          ],
        };
      }

      if (normalized === 'go') {
        return {
          filePath: `${runDir}/run.go`,
          requiredCommands: ['go'],
          steps: [{ command: 'go', args: ['run', `${runDir}/run.go`] }],
        };
      }

      if (['ruby', 'rb'].includes(normalized)) {
        return {
          filePath: `${runDir}/run.rb`,
          requiredCommands: ['ruby'],
          steps: [{ command: 'ruby', args: [`${runDir}/run.rb`] }],
        };
      }

      return null;
    };

    const runProcess = async (command: string, args: string[]) => {
      const wc = await webcontainer;
      const process = await wc.spawn(command, args);
      const reader = process.output.getReader();
      let output = '';

      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        output += value || '';
      }

      const exitCode = await process.exit;

      return { output, exitCode };
    };

    const commandExists = async (command: string) => {
      const result = await runProcess('jsh', ['-lc', `command -v ${command}`]);

      return result.exitCode === 0;
    };

    const runCode = async () => {
      if (running) {
        return;
      }

      const spec = buildRunSpec(language ?? 'plaintext');

      if (!spec) {
        window.alert(`暂不支持运行 ${language ?? 'plaintext'} 代码`);
        return;
      }

      try {
        setRunning(true);
        setRunOutput('');
        setRunExitCode(null);

        const wc = await webcontainer;
        await wc.fs.mkdir('.bolt-runner', { recursive: true });
        await wc.fs.writeFile(spec.filePath, code);

        for (const cmd of spec.requiredCommands) {
          const exists = await commandExists(cmd);

          if (!exists) {
            setRunOutput(`当前环境不支持 ${language ?? 'plaintext'} 运行：缺少命令 ${cmd}`);
            setRunExitCode(127);

            return;
          }
        }

        let allOutput = '';
        let finalExitCode = 0;

        for (const step of spec.steps) {
          const result = await runProcess(step.command, step.args);
          allOutput += result.output;
          finalExitCode = result.exitCode;

          if (result.exitCode !== 0) {
            break;
          }
        }

        setRunOutput(cleanTerminalOutput(allOutput || '(无输出)'));
        setRunExitCode(finalExitCode);
      } catch (error) {
        setRunOutput(`运行失败: ${error instanceof Error ? error.message : String(error)}`);
        setRunExitCode(1);
        logger.error('Failed to run code block', error);
      } finally {
        setRunning(false);
      }
    };

    useEffect(() => {
      let effectiveLanguage = language;

      if (language && !isSpecialLang(language) && !(language in bundledLanguages)) {
        logger.warn(`Unsupported language '${language}', falling back to plaintext`);
        effectiveLanguage = 'plaintext';
      }

      logger.trace(`Language = ${effectiveLanguage}`);

      const processCode = async () => {
        setHTML(await codeToHtml(code, { lang: effectiveLanguage, theme }));
      };

      processCode();
    }, [code, language, theme]);

    return (
      <div className={classNames('relative group text-left', className)}>
        <div
          className={classNames(
            styles.CopyButtonContainer,
            'bg-transparant absolute top-[10px] right-[10px] rounded-md z-10 text-lg flex items-center justify-center opacity-0 group-hover:opacity-100',
          )}
        >
          {!disableCopy && (
            <>
              <button
                className="flex items-center bg-accent-500 p-[6px] justify-center rounded-md transition-theme mr-1"
                title="运行代码"
                onClick={() => runCode()}
              >
                <div className={classNames(running ? 'i-svg-spinners:90-ring-with-bg' : 'i-ph:play-duotone')} />
              </button>
              <button
                className={classNames(
                  'flex items-center bg-accent-500 p-[6px] justify-center before:bg-white before:rounded-l-md before:text-gray-500 before:border-r before:border-gray-300 rounded-md transition-theme',
                  {
                    'before:opacity-0': !copied,
                    'before:opacity-100': copied,
                  },
                )}
                title="复制代码"
                onClick={() => copyToClipboard()}
              >
                <div className="i-ph:clipboard-text-duotone" />
              </button>
            </>
          )}
        </div>
        <div dangerouslySetInnerHTML={{ __html: html ?? '' }} />
        {(runOutput || runExitCode !== null) && (
          <div className="mt-2 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2">
            <div className="px-3 py-2 text-xs text-bolt-elements-textSecondary border-b border-bolt-elements-borderColor">
              运行结果 {runExitCode !== null ? `(exit ${runExitCode})` : ''}
            </div>
            <pre className="m-0 p-3 text-xs overflow-x-auto whitespace-pre-wrap break-words">{runOutput}</pre>
          </div>
        )}
      </div>
    );
  },
);
