import { Module } from '@nestjs/common';
import { AssociationAuditController } from './association-audit.controller';
import { AssociationAuditService } from './association-audit.service';

@Module({
  controllers: [AssociationAuditController],
  providers: [AssociationAuditService],
  exports: [AssociationAuditService],
})
export class AssociationAuditModule {}
