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

    const { method, path, query, user } = request;
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
