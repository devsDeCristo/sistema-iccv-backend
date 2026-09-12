import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  Logger,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';

/**
 * O segredo da URL de notificação não pode chegar ao log.
 *
 * Ele vai no caminho porque nenhuma das casas de pagamento deixa cadastrar um
 * cabeçalho próprio — só a URL. O preço disso é que a URL inteira vira material
 * de credencial, e um log de aplicação costuma ser lido por muito mais gente do
 * que o banco: `/webhooks/pagbank/<segredo>/payments` chegaria ali inteiro, e
 * quem o lesse poderia marcar qualquer inscrição como paga.
 *
 * Apaga o terceiro trecho sempre que houver um quarto — é essa a posição do
 * segredo. Casar com o formato exato `casa/segredo/canal` não bastava: o
 * Express casa a rota com barra no fim, e `/webhooks/pagbank/<segredo>/payments/`
 * escapava da conferência e ia inteiro para o log. O mesmo valia para qualquer
 * sondagem com um trecho a mais, que cai no 404 e é registrada do mesmo jeito.
 *
 * As rotas antigas do PagBank têm dois trechos e não carregam segredo: elas
 * não têm quarto trecho, então continuam legíveis.
 */
function esconderSegredos(path: string): string {
  return path.replace(/^(\/webhooks\/[^/]+)\/[^/]+(?=\/)/, '$1/•••');
}

/**
 * Log de todas as requisições HTTP: quem chamou, de onde, qual rota, e o resultado.
 *
 * O padrão é simples: `[MÉTODO] /caminho - status | tempo`, com o usuário
 * quando há autenticação.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const { method, query, user } = request;
    const path = esconderSegredos(request.path);
    const userName = user?.username ?? user?.userId ?? null;
    const inicio = Date.now();

    // limpa a query string muito comprida
    const queryStr =
      Object.keys(query).length > 0
        ? `?${Object.keys(query)
            .map((k) => `${k}=...`)
            .join('&')}`
        : '';

    // Silencia logs de sucesso para rotas de validação (só loga erros)
    const isSilentRoute =
      path === '/auth/validate' || path === '/auth/admin/validate';

    return next.handle().pipe(
      tap(() => {
        const duracao = Date.now() - inicio;
        const status = response.statusCode;
        const prefixo = userName ? `[${userName}]` : '';

        if (isSilentRoute) return;

        this.logger.log(
          `${prefixo} ${method} ${path}${queryStr} - ${status} | ${duracao}ms`,
        );
      }),
      catchError((erro) => {
        const duracao = Date.now() - inicio;
        const status = erro.status || 500;
        const prefixo = userName ? `[${userName}]` : '';

        this.logger.error(
          `${prefixo} ${method} ${path}${queryStr} - ${status} | ${duracao}ms | ${erro.message}`,
        );

        throw erro;
      }),
    );
  }
}
