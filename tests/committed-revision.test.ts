import { describe, it, expect } from '@jest/globals';
import { committedRevision } from '../common/utils.js';
import { registerJob, finishJob, getJob } from '../common/jobs.js';

/**
 * O caso que motiva tudo isto, medido em campo:
 *
 *     Committed revision 646726.
 *     svn: E200000: Commit succeeded, but other errors follow:
 *     svn: E200033: Error bumping revisions post-commit (details follow):
 *     svn: E200033: sqlite[S5]: database is locked
 *
 * exit code 1, e a revisao esta no repositorio. Classificar como falha convida a
 * repetir, e repetir um commit que entrou e um COMMIT DUPLICADO.
 */
describe('committedRevision', () => {
  it('acha a revisao mesmo quando o svn saiu com erro depois do commit', () => {
    const saida =
      'Sending        Oracle/Objetos/Funcoes/kmmflow.pkg_aprendizado.sql\n' +
      'Transmitting file data .done\n' +
      'Committing transaction...\n' +
      'Committed revision 646726.\n';
    expect(committedRevision(saida)).toBe(646726);
  });

  it('devolve undefined quando nada foi commitado', () => {
    expect(committedRevision('svn: E155007: not a working copy\n')).toBeUndefined();
    expect(committedRevision('')).toBeUndefined();
  });

  it('nao casa a frase citada dentro de uma mensagem de commit', () => {
    // Ancorado no inicio da linha e exigindo o ponto final: mensagem de commit
    // que MENCIONA a frase nao pode ser lida como se fosse a saida do svn.
    const saida = 'Sending file.txt\nreverting Committed revision 999 from last week\n';
    expect(committedRevision(saida)).toBeUndefined();
  });
});

describe('estado do job', () => {
  const novoJob = () => registerJob({ command: 'svn commit', target: '/x', cwd: '/tmp' });

  it('exit 0 e done', () => {
    const j = novoJob();
    finishJob(j.id, 0);
    expect(getJob(j.id)!.state).toBe('done');
  });

  it('exit nao-zero SEM revisao e failed', () => {
    const j = novoJob();
    finishJob(j.id, 1);
    expect(getJob(j.id)!.state).toBe('failed');
  });

  it('exit nao-zero COM revisao e done-with-warnings, nao failed', () => {
    const j = novoJob();
    finishJob(j.id, 1, undefined, 646726);
    const lido = getJob(j.id)!;
    expect(lido.state).toBe('done-with-warnings');
    expect(lido.committedRevision).toBe(646726);
    // O que nao pode acontecer de jeito nenhum:
    expect(lido.state).not.toBe('failed');
  });
});
